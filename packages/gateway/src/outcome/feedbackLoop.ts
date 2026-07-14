import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { OnchainosClient } from "../okx/onchainosClient.js";
import { TERMINAL_TASK_STATUS_CODES, type TaskStatusCode } from "../okx/types.js";

/**
 * Outcome Feedback Loop (spec §4.1 / §5.2, "routed" source): for every task
 * Assay itself is a party to — a routed hire from a deep assessment, or a
 * canary dispatch already covered by canary/dispatcher.ts — poll
 * `agent status <jobId>` (publicly queryable, unlike the private negotiation
 * channel) until it reaches a terminal status, then write the resolution
 * into the Outcome Ledger. This is what makes Assay's own routing data
 * compound over time (spec §3.2) instead of being a static snapshot.
 */

const RESOLUTION_BY_STATUS: Record<string, "released_clean" | "disputed_for_agent" | "disputed_against_agent" | "abandoned"> = {
  completed: "released_clean",
  close: "abandoned",
  expired: "abandoned",
  failed: "disputed_against_agent",
  admin_stopped: "abandoned"
};

export interface PendingRoutedJob {
  jobId: string;
  agentRowId: string;
  okxAgentId: string;
  skillCategoryId: string | null;
  requesterWallet: string | null;
}

/** Assessments whose requester hired a candidate (routed_job_id set) but whose outcome hasn't been recorded yet. */
export async function pendingRoutedAssessments(db: Kysely<Database>): Promise<PendingRoutedJob[]> {
  // The requester-hired agent isn't a foreign key on `assessments` (ranked_candidates
  // is a JSON snapshot, not a relation) — resolve it by matching okx_agent_id inside
  // the JSON payload against the agents table instead of a SQL join.
  const pending = await db
    .selectFrom("assessments")
    .select(["id", "routed_job_id", "skill_category_id", "requester_identifier", "ranked_candidates"])
    .where("routed_job_id", "is not", null)
    .where("resolved_at", "is", null)
    .execute();

  const results: PendingRoutedJob[] = [];
  for (const row of pending) {
    if (!row.routed_job_id) continue;
    const candidates = row.ranked_candidates as Array<{ agent_id?: string }> | null;
    const hiredOkxAgentId = Array.isArray(candidates) && candidates[0]?.agent_id ? candidates[0].agent_id : null;
    if (!hiredOkxAgentId) continue;

    const agentRow = await db.selectFrom("agents").select(["id"]).where("okx_agent_id", "=", hiredOkxAgentId).executeTakeFirst();
    if (!agentRow) continue;

    results.push({
      jobId: row.routed_job_id,
      agentRowId: agentRow.id,
      okxAgentId: hiredOkxAgentId,
      skillCategoryId: row.skill_category_id,
      requesterWallet: row.requester_identifier
    });
  }
  return results;
}

/** Canary dispatches that reached `delivered` but whose outcome hasn't yet been mirrored into the ledger. */
export async function pendingRoutedCanaries(db: Kysely<Database>): Promise<PendingRoutedJob[]> {
  const rows = await db
    .selectFrom("canary_dispatches as cd")
    .innerJoin("agents as a", "a.id", "cd.agent_id")
    .innerJoin("canary_tasks as ct", "ct.id", "cd.canary_task_id")
    .select(["cd.id as dispatch_id", "cd.okx_job_id", "a.id as agent_row_id", "a.okx_agent_id", "ct.skill_category_id"])
    .where("cd.status", "in", ["delivered", "graded"])
    .where("cd.okx_job_id", "is not", null)
    .execute();

  return rows
    .filter((r): r is typeof r & { okx_job_id: string } => r.okx_job_id !== null)
    .map((r) => ({
      jobId: r.okx_job_id,
      agentRowId: r.agent_row_id,
      okxAgentId: r.okx_agent_id,
      skillCategoryId: r.skill_category_id,
      requesterWallet: null
    }));
}

export async function reconcileOne(client: OnchainosClient, db: Kysely<Database>, job: PendingRoutedJob): Promise<"pending" | "recorded"> {
  const status = await client.taskStatus(job.jobId);
  const code = String(status.statusCode ?? "");
  const isTerminal = TERMINAL_TASK_STATUS_CODES.has(code as TaskStatusCode) || status.status in RESOLUTION_BY_STATUS;
  if (!isTerminal) return "pending";

  const resolution = RESOLUTION_BY_STATUS[status.status] ?? "abandoned";

  await db
    .insertInto("outcome_ledger_entries")
    .values({
      agent_id: job.agentRowId,
      skill_category_id: job.skillCategoryId,
      okx_job_id: job.jobId,
      source: "routed",
      requester_wallet_address: job.requesterWallet,
      resolution,
      escrow_amount: status.tokenAmount !== undefined ? Number(status.tokenAmount) : null,
      escrow_token: status.tokenSymbol ?? null,
      review_score: null,
      occurred_at: new Date()
    })
    .onConflict((oc) => oc.columns(["okx_job_id", "agent_id"]).doNothing())
    .execute();

  await db.updateTable("assessments").set({ resolved_at: new Date() }).where("routed_job_id", "=", job.jobId).execute();

  return "recorded";
}

export async function reconcileAll(client: OnchainosClient, db: Kysely<Database>): Promise<{ recorded: number; pending: number }> {
  const jobs = [...(await pendingRoutedAssessments(db)), ...(await pendingRoutedCanaries(db))];
  let recorded = 0;
  let pending = 0;
  for (const job of jobs) {
    const outcome = await reconcileOne(client, db, job);
    if (outcome === "recorded") recorded++;
    else pending++;
  }
  return { recorded, pending };
}
