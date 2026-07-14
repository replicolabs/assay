import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildShortlist, persistAssessment } from "./assessmentService.js";
import { buildTaskSpec } from "../intake/specEngine.js";
import type { AppDeps } from "./deps.js";
import type { Assessment } from "./contracts.js";

/**
 * Agent-to-Agent deep assessment (spec §7.2). Negotiated, escrow-backed —
 * a few minutes of latency is a fair trade for depth here. Implemented as
 * two calls rather than a long-lived negotiation session, matching what's
 * actually buildable without OKX.AI's own A2A negotiation transport wired
 * in yet (see README §OKX.AI integration for what still needs live credentials):
 *
 *   1. POST /v1/assess/start   — spec intake (LLM-backed acceptance criteria)
 *                                 + shortlist, fee_status starts "pending"
 *   2. POST /v1/assess/:id/hire — requester tells Assay which candidate they
 *                                 hired and the resulting OKX jobId; the
 *                                 Outcome Feedback Loop (outcome/feedbackLoop.ts)
 *                                 later resolves fee_status once that job
 *                                 reaches a terminal on-chain status.
 */

const StartRequestSchema = z.object({
  task_summary: z.string().min(1),
  budget_hint: z.string().optional(),
  requester_identifier: z.string().optional(),
  max_candidates: z.number().int().positive().max(20).default(5)
});

const HireRequestSchema = z.object({
  agent_id: z.string(),
  job_id: z.string()
});

export function registerAssessRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/v1/assess/start", async (request, reply) => {
    const parsed = StartRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    const body = parsed.data;

    // Falls back to an unclassified spec if no LLM is configured (e.g. local dev
    // without ANTHROPIC_API_KEY) rather than failing the whole request — the
    // shortlist pipeline still works fine against the "general" category.
    const spec = await buildTaskSpec(deps.llm, body.task_summary, body.budget_hint).catch(() => ({
      skillCategoryId: "general",
      acceptanceCriteria: [],
      clarifyingQuestions: []
    }));

    const candidates = await buildShortlist(deps, {
      taskSummary: body.task_summary,
      skillCategoryId: spec.skillCategoryId,
      maxCandidates: body.max_candidates
    });

    const requestId = await persistAssessment(deps.db, {
      channel: "a2a",
      taskSummary: body.task_summary,
      skillCategoryId: spec.skillCategoryId,
      acceptanceCriteria: spec.acceptanceCriteria,
      requesterIdentifier: body.requester_identifier ?? null,
      candidates,
      feeStatus: "pending"
    });

    const assessment: Assessment = {
      request_id: requestId,
      channel: "a2a",
      task_summary: body.task_summary,
      skill_category_id: spec.skillCategoryId,
      acceptance_criteria: spec.acceptanceCriteria,
      candidates
    };
    return reply.send({ ...assessment, clarifying_questions: spec.clarifyingQuestions });
  });

  app.post<{ Params: { id: string } }>("/v1/assess/:id/hire", async (request, reply) => {
    const parsed = HireRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const existing = await deps.db.selectFrom("assessments").select(["id"]).where("id", "=", request.params.id).executeTakeFirst();
    if (!existing) {
      return reply.status(404).send({ error: "assessment not found" });
    }

    await deps.db.updateTable("assessments").set({ routed_job_id: parsed.data.job_id }).where("id", "=", request.params.id).execute();

    return reply.send({ request_id: request.params.id, routed_job_id: parsed.data.job_id, fee_status: "pending" });
  });
}
