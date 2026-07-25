import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { EngineClient } from "../engine/engineClient.js";
import type { LLMClient } from "../intake/llmClient.js";
import { buildTaskSpec } from "../intake/specEngine.js";
import { buildShortlist, persistAssessment } from "../api/assessmentService.js";
import type { RankedCandidate } from "../api/contracts.js";
import type { OnchainosClient } from "./onchainosClient.js";

/**
 * Completes the negotiated A2A "Deep Assessment" flow for real, on-chain
 * accepted tasks — the piece that was missing entirely before 2026-07-25.
 * `a2aResponder.ts` only sends the cold-start opener; nothing turned a real
 * `job_accepted` task into a real deliverable. The daemon's autonomous
 * Claude session would otherwise have to improvise one from general
 * reasoning instead of running Assay's actual canary-tested evaluation
 * engine — this module wires the real thing in instead.
 *
 * Deliberately gated on on-chain `accepted` status (job_accepted), not
 * `created` — per OKX's own protocol (okx-ai skill, task-asp.md): "deliver
 * is gated by job_accepted"; the CLI itself rejects an earlier attempt with
 * `status != accepted`, and delivering before escrow is funded would mean
 * working for free even if it didn't.
 */
export async function deliverAcceptedAspTasks(
  client: OnchainosClient,
  deps: { db: Kysely<Database>; engine: EngineClient; llm: LLMClient },
  aspAgentId: string
): Promise<{ delivered: string[] }> {
  const { providerTasks } = await client.taskInProgress([aspAgentId]);
  const delivered: string[] = [];

  for (const task of providerTasks) {
    if (task.providerAgentId !== aspAgentId || task.status !== 1) continue;
    // Live-verified 2026-07-25: `agent deliver` rejects any task whose
    // paymentMode isn't 1 (escrow) — "deliver/submit is only supported for
    // escrow (1). x402 tasks skip the submit step; the User Agent obtains
    // the deliverable by replaying the ASP's endpoint." An x402-mode
    // (paymentMode 3) task reaching `accepted` completes itself atomically
    // through the /v1/lookup HTTP replay (payments.ts) — there's nothing for
    // this loop to do for it, and calling deliver anyway both fails on-chain
    // every tick AND wastefully re-runs the real LLM/evaluation pipeline for
    // a job that was never going anywhere.
    if (task.paymentMode !== 1) continue;

    const already = await deps.db.selectFrom("a2a_delivered_tasks").select("job_id").where("job_id", "=", task.jobId).executeTakeFirst();
    if (already) continue;

    const spec = await buildTaskSpec(deps.llm, task.description).catch(() => ({
      skillCategoryId: "general",
      acceptanceCriteria: [],
      clarifyingQuestions: []
    }));

    const candidates = await buildShortlist(
      { client, db: deps.db, engine: deps.engine },
      { taskSummary: task.description, skillCategoryId: spec.skillCategoryId, maxCandidates: 5 }
    );

    const requestId = await persistAssessment(deps.db, {
      channel: "a2a",
      taskSummary: task.description,
      skillCategoryId: spec.skillCategoryId,
      acceptanceCriteria: spec.acceptanceCriteria,
      requesterIdentifier: task.buyerAgentId ?? null,
      candidates,
      // Delivered, not yet paid out — the buyer still has to call `complete`
      // to release escrow. Matches /v1/assess/start's same "pending" default;
      // the Outcome Feedback Loop resolves this once the job goes terminal.
      feeStatus: "pending"
    });

    const deliverableText = formatDeliverable(task.title, task.description, spec.acceptanceCriteria, candidates);
    await client.deliver(task.jobId, aspAgentId, deliverableText, "Ranked shortlist and engagement plan attached.");

    await deps.db
      .insertInto("a2a_delivered_tasks")
      .values({ job_id: task.jobId, okx_agent_id: aspAgentId, counterparty_agent_id: task.buyerAgentId ?? null, assessment_request_id: requestId })
      .onConflict((oc) => oc.column("job_id").doNothing())
      .execute();
    delivered.push(task.jobId);
  }

  return { delivered };
}

function formatDeliverable(
  title: string,
  taskDescription: string,
  acceptanceCriteria: { id: string; description: string; testable: boolean }[],
  candidates: RankedCandidate[]
): string {
  const criteriaBlock = acceptanceCriteria.length
    ? acceptanceCriteria.map((c) => `- ${c.description}${c.testable ? "" : " (subjective)"}`).join("\n")
    : "- (none generated — request was specific enough not to need any)";

  const candidatesBlock = candidates.length
    ? candidates
        .map(
          (c, i) =>
            `${i + 1}. **${c.agent_name}** (agent #${c.agent_id}) — score ${c.score.toFixed(2)}, confidence: ${c.confidence_bucket}\n   ${c.fit_reasoning}\n   Recommended terms: ${c.recommended_terms.escrow_split} escrow split, ${c.recommended_terms.milestone_structure}${c.recommended_terms.require_stricter_acceptance_criteria ? ", stricter acceptance criteria advised" : ""}`
        )
        .join("\n\n")
    : "No candidates met the minimum evidence bar for this request.";

  return `# Deep Assessment: ${title}

## Request
${taskDescription}

## Acceptance Criteria
${criteriaBlock}

## Ranked Shortlist
${candidatesBlock}

---
Generated by Assay's evaluation engine (canary testing + real outcome history), not a bare popularity score.`;
}

export function startA2ADelivererLoop(
  client: OnchainosClient,
  deps: { db: Kysely<Database>; engine: EngineClient; llm: LLMClient },
  aspAgentId: string,
  intervalMs = 3 * 60 * 1000
): () => void {
  const tick = () => {
    deliverAcceptedAspTasks(client, deps, aspAgentId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[a2a-deliverer] failed:", err);
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
