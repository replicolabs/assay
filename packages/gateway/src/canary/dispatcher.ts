import { readFile } from "node:fs/promises";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/schema.js";
import type { EngineClient } from "../engine/engineClient.js";
import type { OnchainosClient } from "../okx/onchainosClient.js";
import { TERMINAL_TASK_STATUS_CODES, type TaskStatusCode } from "../okx/types.js";

export interface DispatchTarget {
  agentRowId: string;
  okxAgentId: string;
}

export interface CanaryTaskRow {
  id: string;
  skill_category_id: string;
  prompt_payload: unknown;
  grading_mode: "exact" | "schema" | "numeric" | "rubric";
}

/**
 * Publishes a canary as a real designated-provider task against the target
 * ASP, paid from Assay's own buyer identity — the hard constraint from spec
 * §3.1 (canaries must be statistically indistinguishable from real tasks)
 * is satisfied structurally here: this *is* a real marketplace task, just one
 * whose correct answer Assay already knows.
 *
 * The buyer identity itself isn't a parameter here: verified against the live
 * `onchainos` CLI, `create-task` resolves the caller's agent from the active
 * wallet session, not from a flag — the operator is responsible for having
 * Assay's buyer wallet (`ASSAY_BUYER_AGENT_ID`, see README §Setup) logged in
 * before this runs.
 */
export async function dispatchCanary(
  client: OnchainosClient,
  db: Kysely<Database>,
  target: DispatchTarget,
  canaryTask: CanaryTaskRow
): Promise<{ dispatchId: string; jobId: string }> {
  const payload = canaryTask.prompt_payload as {
    title: string;
    description: string;
    descriptionSummary: string;
    budget: string;
    maxBudget: string;
    currency: "USDT" | "USDG";
    serviceId?: string;
  };

  const created = await client.createTask({
    title: payload.title,
    description: payload.description,
    descriptionSummary: payload.descriptionSummary,
    budget: payload.budget,
    maxBudget: payload.maxBudget,
    currency: payload.currency,
    provider: target.okxAgentId,
    visibility: 1,
    serviceId: payload.serviceId,
    paymentMode: "escrow"
  });

  const dispatch = await db
    .insertInto("canary_dispatches")
    .values({
      canary_task_id: canaryTask.id,
      agent_id: target.agentRowId,
      okx_job_id: created.jobId,
      status: "published"
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { dispatchId: dispatch.id, jobId: created.jobId };
}

/** Polls one dispatch's task status; updates local state when it reaches a terminal status. */
export async function pollDispatch(client: OnchainosClient, db: Kysely<Database>, dispatchId: string, jobId: string): Promise<{ terminal: boolean; status: string }> {
  const status = await client.taskStatus(jobId);
  const code = String(status.statusCode ?? "");
  const terminal =
    TERMINAL_TASK_STATUS_CODES.has(code as TaskStatusCode) || status.status === "completed" || status.status === "submitted";

  if (terminal) {
    await db
      .updateTable("canary_dispatches")
      .set({ status: "delivered", delivered_at: new Date() })
      .where("id", "=", dispatchId)
      .where("status", "=", "published")
      .execute();
  }

  return { terminal, status: status.status };
}

/**
 * Fetches the ASP's deliverable and grades it against the canary's reference
 * output via the evaluation engine, then records the result. This is the
 * step spec §5.1 calls "grading combines automated rubric scoring" — the
 * automated half; a subjective-output secondary review pass is a separate,
 * pluggable extension not wired here.
 */
export async function gradeDispatch(
  client: OnchainosClient,
  engine: EngineClient,
  db: Kysely<Database>,
  dispatchId: string,
  jobId: string,
  canaryTask: CanaryTaskRow,
  agentOkxId: string
): Promise<{ score: number }> {
  const deliverables = await client.taskDeliverableList(jobId, "user");
  const first = deliverables[0];
  if (!first) {
    throw new Error(`no deliverable found for job ${jobId} — cannot grade`);
  }

  const raw = await readFile(first.path, "utf8");
  const output: unknown = first.deliverableType === "text" ? tryParseJson(raw) : { fileText: raw };

  const dispatchRow = await db.selectFrom("canary_dispatches").select(["agent_id"]).where("id", "=", dispatchId).executeTakeFirstOrThrow();

  const graded = await engine.gradeCanary({
    canaryTaskId: canaryTask.id,
    dispatchId,
    agentId: dispatchRow.agent_id,
    skillCategoryId: canaryTask.skill_category_id,
    output
  });

  await db.updateTable("canary_dispatches").set({ status: "graded", graded_at: new Date() }).where("id", "=", dispatchId).execute();

  return { score: graded.score };
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

// --- Dispatch cadence scheduling -------------------------------------------

export interface SurfaceStat {
  agentRowId: string;
  okxAgentId: string;
  surfaceCount30d: number;
  lastDispatchedAt: Date | null;
}

/**
 * Cadence proportional to how often the agent is being surfaced in live
 * recommendations (spec §5.1): frequently-recommended agents get retested
 * weekly, occasionally-recommended agents biweekly, idle agents monthly.
 */
export function isDueForCanary(stat: SurfaceStat, now: Date = new Date()): boolean {
  const intervalDays = stat.surfaceCount30d >= 5 ? 7 : stat.surfaceCount30d >= 1 ? 14 : 30;
  if (!stat.lastDispatchedAt) return true;
  const ageDays = (now.getTime() - stat.lastDispatchedAt.getTime()) / 86_400_000;
  return ageDays >= intervalDays;
}

/** How many times each agent appeared in an Assessment's ranked_candidates in the last 30 days. */
export async function surfaceCounts(db: Kysely<Database>, agentOkxIds: string[]): Promise<Map<string, number>> {
  if (agentOkxIds.length === 0) return new Map();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .selectFrom("assessments")
    .select(["ranked_candidates"])
    .where("created_at", ">=", since)
    .execute();

  const counts = new Map<string, number>();
  for (const id of agentOkxIds) counts.set(id, 0);
  for (const row of rows) {
    const candidates = row.ranked_candidates as Array<{ agent_id?: string }> | null;
    if (!Array.isArray(candidates)) continue;
    for (const c of candidates) {
      if (c.agent_id && counts.has(c.agent_id)) {
        counts.set(c.agent_id, (counts.get(c.agent_id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export async function lastDispatchTimes(db: Kysely<Database>, agentRowIds: string[]): Promise<Map<string, Date>> {
  if (agentRowIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("canary_dispatches")
    .select(["agent_id", sql<Date>`max(dispatched_at)`.as("last_dispatched")])
    .where("agent_id", "in", agentRowIds)
    .groupBy("agent_id")
    .execute();
  return new Map(rows.map((r) => [r.agent_id, r.last_dispatched]));
}
