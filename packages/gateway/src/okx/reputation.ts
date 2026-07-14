import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { OnchainosClient } from "./onchainosClient.js";

/**
 * Ingests public `agent feedback-list` reviews as the Outcome Ledger's
 * organic (non-Assay-routed) signal — see README §OKX.AI integration for why:
 * raw task/escrow event streams are peer-permissioned over XMTP and not
 * publicly subscribable for arbitrary third-party tasks, but per-agent
 * reviews (with a task hash, a 0-5 score, and a reviewer) are public.
 *
 * Approximation worth stating explicitly: feedback-list doesn't carry a
 * dispute outcome, only a post-hoc rating, so every ingested row is recorded
 * as `released_clean` (the normal path a review gets submitted on) with the
 * review's own score carrying the actual signal — a low-scored clean release
 * still reads as a weak outcome once scoring.rs converts review_score to a
 * component, it isn't rounded up to "good" just because the resolution enum
 * says clean.
 */
export async function ingestFeedback(client: OnchainosClient, db: Kysely<Database>, agentRowId: string, okxAgentId: string, skillCategoryId: string | null): Promise<number> {
  const items = await client.listFeedback(okxAgentId);
  let inserted = 0;

  for (const item of items) {
    const jobId = item.taskHash ?? item.taskId;
    if (!jobId) continue; // no stable dedupe key -> skip rather than risk double-counting

    const occurredAt = item.date ? new Date(item.date) : new Date();

    const result = await db
      .insertInto("outcome_ledger_entries")
      .values({
        agent_id: agentRowId,
        skill_category_id: skillCategoryId,
        okx_job_id: jobId,
        source: "organic_feedback",
        requester_wallet_address: item.reviewerId ? `reviewer:${item.reviewerId}` : null,
        resolution: "released_clean",
        escrow_amount: null,
        escrow_token: null,
        review_score: item.score,
        occurred_at: occurredAt
      })
      .onConflict((oc) => oc.columns(["okx_job_id", "agent_id"]).doNothing())
      .executeTakeFirst();

    if (result.numInsertedOrUpdatedRows && result.numInsertedOrUpdatedRows > 0n) inserted++;
  }

  return inserted;
}
