import { readFile } from "node:fs/promises";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/schema.js";
import type { EngineClient } from "../engine/engineClient.js";
import type { OnchainosClient } from "../okx/onchainosClient.js";
import { TERMINAL_TASK_STATUS_CODES, type TaskStatusCode } from "../okx/types.js";
import { fetchA2ADeliverablePath } from "../okx/xmtpDeliverable.js";

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

export type DispatchPaymentMode = "escrow" | "x402";

export class DispatchPreflightError extends Error {}

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
 *
 * Payment mode is *not* a fixed choice — it's resolved from the target
 * service's real, freshly-fetched `serviceType`, not guessed or hardcoded:
 * A2A -> escrow (create -> [ASP accepts/submits] -> grade -> `complete()`
 * releases payment). A2MCP -> x402 (pay-and-deliver atomically via
 * `x402Check` + `task402Pay`, no separate release step). A canary aimed at
 * an A2MCP-only agent (e.g. a service that never registered an A2A offering)
 * used to be silently undispatchable through this function; it isn't now.
 *
 * Two live-verified preflight checks run before anything is spent:
 * `serviceId` must be present (`create-task --provider` without one fails
 * server-side with "serviceId is required when providerAgentId is
 * specified"), and the target must currently be online (`onlineStatus`) —
 * "designated provider not online" is a real, observed failure otherwise.
 * Both throw `DispatchPreflightError` before any network write happens.
 */
export async function dispatchCanary(
  client: OnchainosClient,
  db: Kysely<Database>,
  target: DispatchTarget,
  canaryTask: CanaryTaskRow
): Promise<{ dispatchId: string; jobId: string; paymentMode: DispatchPaymentMode }> {
  const payload = canaryTask.prompt_payload as {
    title: string;
    description: string;
    descriptionSummary: string;
    budget: string;
    maxBudget: string;
    currency: "USDT" | "USDG";
    serviceId: string;
  };

  if (!payload.serviceId) {
    throw new DispatchPreflightError(
      `canary_task ${canaryTask.id} has no serviceId in prompt_payload — create-task rejects a designated ` +
        `provider without one ("serviceId is required when providerAgentId is specified"). Fix the canary content, not this call.`
    );
  }

  const [agentDetail] = await client.getAgents([target.okxAgentId]);
  if (!agentDetail || agentDetail.onlineStatus !== 1) {
    throw new DispatchPreflightError(`designated provider ${target.okxAgentId} is not online (onlineStatus=${agentDetail?.onlineStatus ?? "unknown"}) — skipping dispatch rather than spending into a dead endpoint.`);
  }

  const services = await client.listServices(target.okxAgentId);
  const service = services.find((s) => s.serviceId === payload.serviceId);
  if (!service) {
    throw new DispatchPreflightError(`service ${payload.serviceId} not found on agent ${target.okxAgentId}'s current service-list — it may have been removed or changed since this canary was authored.`);
  }

  const paymentMode: DispatchPaymentMode = service.serviceType === "a2mcp" ? "x402" : "escrow";

  // Goes through draft create -> draft publish rather than a direct
  // `create-task` call. Live-verified difference: `create-task` prints
  // human-readable console text (checkmarks, "jobId: ...") when called
  // directly, NOT JSON — this client's `run()` always expects JSON, so a
  // direct createTask() call here throws OnchainosParseError *after* the
  // task has already been created and broadcast on-chain, orphaning it from
  // Assay's own DB. The draft flow returns clean JSON at every step (proven
  // live, twice) and gets the exact same on-chain result.
  const draft = await client.draftCreate({
    title: payload.title,
    description: payload.description,
    descriptionSummary: payload.descriptionSummary,
    budget: payload.budget,
    maxBudget: payload.maxBudget,
    currency: payload.currency,
    provider: target.okxAgentId,
    visibility: 1,
    serviceId: payload.serviceId,
    paymentMode
  });
  const created = await client.draftPublish(draft.jobId);

  let initialStatus: "published" | "delivered" = "published";

  if (paymentMode === "x402") {
    if (!service.endpoint) {
      throw new DispatchPreflightError(`service ${payload.serviceId} is A2MCP but has no endpoint on record — cannot x402-pay it.`);
    }
    const check = await client.x402Check(service.endpoint);
    await client.task402Pay(created.jobId, {
      providerAgentId: target.okxAgentId,
      accepts: check.acceptsJson,
      endpoint: service.endpoint,
      tokenSymbol: check.tokenSymbol ?? payload.currency,
      tokenAmount: String(check.amountHuman ?? payload.budget)
    });
    // x402 settles and delivers atomically — there's no separate ASP
    // accept/submit phase to poll for, unlike escrow.
    initialStatus = "delivered";
  }

  const dispatch = await db
    .insertInto("canary_dispatches")
    .values({
      canary_task_id: canaryTask.id,
      agent_id: target.agentRowId,
      okx_job_id: created.jobId,
      status: initialStatus,
      ...(initialStatus === "delivered" ? { delivered_at: new Date() } : {})
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { dispatchId: dispatch.id, jobId: created.jobId, paymentMode };
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
 *
 * `complete()` is called unconditionally after a successful grade, for both
 * payment modes. Escrow tasks are only *held* in escrow up to this point —
 * nothing releases payment to the ASP without this explicit `complete()`
 * call. x402 tasks already settled payment atomically at dispatch time (see
 * dispatchCanary's `task402Pay`) — but live-verified on a real x402 job
 * (balance checked before/after `agent complete`, unchanged) `complete()`
 * does NOT re-release funds there; it's a safe no-op for payment that is
 * still required to transition the on-chain task's *status* to a terminal
 * state. Without it, x402 dispatches stay stuck at "accepted" forever and
 * `reconcileOne` (src/outcome/feedbackLoop.ts), which only records an
 * outcome_ledger_entries row once a terminal status is observed, can never
 * record an outcome for them.
 *
 * Deliverable retrieval has two paths, tried in order: `onchainos`'s
 * `task-deliverable-list` (works for x402 — the deliverable is embedded in
 * the payment response and mirrored there), then a fallback through the
 * separate `okx-a2a` XMTP messaging layer for escrow/A2A tasks, whose
 * deliverables never appear via `task-deliverable-list` at all (live-verified:
 * confirmed empty even after a real task reached `submitted`). `buyerAgentId`
 * must be Assay's own buyer identity — the XMTP recipient the attachment was
 * encrypted for, not the ASP being graded.
 */
export async function gradeDispatch(
  client: OnchainosClient,
  engine: EngineClient,
  db: Kysely<Database>,
  dispatchId: string,
  jobId: string,
  canaryTask: CanaryTaskRow,
  agentOkxId: string,
  paymentMode: DispatchPaymentMode,
  buyerAgentId: string
): Promise<{ score: number }> {
  const deliverables = await client.taskDeliverableList(jobId, "user");
  let deliverablePath = deliverables[0]?.path;
  let isTextDeliverable = deliverables[0]?.deliverableType === "text";

  if (!deliverablePath) {
    const a2aPath = await fetchA2ADeliverablePath(jobId, buyerAgentId);
    if (!a2aPath) {
      throw new Error(`no deliverable found for job ${jobId} — cannot grade (checked both task-deliverable-list and the A2A XMTP message queue)`);
    }
    deliverablePath = a2aPath;
    isTextDeliverable = true;
  }

  const raw = await readFile(deliverablePath, "utf8");
  const output: unknown = isTextDeliverable ? tryParseJson(raw) : { fileText: raw };

  const dispatchRow = await db.selectFrom("canary_dispatches").select(["agent_id"]).where("id", "=", dispatchId).executeTakeFirstOrThrow();

  const graded = await engine.gradeCanary({
    canaryTaskId: canaryTask.id,
    dispatchId,
    agentId: dispatchRow.agent_id,
    skillCategoryId: canaryTask.skill_category_id,
    output
  });

  // Called unconditionally for both payment modes. Escrow: this is the
  // release — nothing pays the ASP without it. x402: `task402Pay` already
  // settled payment atomically at dispatch time, but `agent complete` is
  // still required afterward purely to finalize the on-chain task STATUS
  // (not payment) to a terminal state. Live-verified safe on a real x402
  // job (0xee3ff520964199e2f9294c17041a159cc4d7de4e1bc8f0a322b01008260de915):
  // wallet balance was checked before/after and was unchanged, and the CLI's
  // own output confirmed it recognized the job as already paid via x402 and
  // did not re-release funds ("Task complete done (x402); status → complete").
  // Without this call, x402 dispatches stay stuck at "accepted" forever and
  // reconcileOne (src/outcome/feedbackLoop.ts) can never record an outcome
  // for them, since it only fires once a terminal status is observed.
  await client.complete(jobId);

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
