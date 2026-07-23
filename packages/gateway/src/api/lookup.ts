import type { FastifyInstance, FastifyReply } from "fastify";
import { LookupRequestSchema, type Assessment, type LookupRequest } from "./contracts.js";
import { buildShortlist, persistAssessment } from "./assessmentService.js";
import { buildChallenge, settlePayment, verifyPayment } from "../okx/payments.js";
import type { AppDeps } from "./deps.js";

/**
 * Agent-to-MCP fast lookup (spec §7.1): stateless, pay-per-call, x402-compliant.
 * No negotiation — an orchestrator agent mid-negotiation needing a subcontractor
 * recommendation in under a second, not a few minutes of deliberation. The human
 * web UI shares the same pipeline via /v1/web/lookup, just without the payment gate.
 */
export function registerLookupRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/v1/lookup", async (request, reply) => {
    const paymentHeader = request.headers["x-payment"];
    const verification = await verifyPayment(Array.isArray(paymentHeader) ? paymentHeader[0] : paymentHeader, deps.x402);

    if (!verification.valid) {
      const challenge = buildChallenge(deps.x402, "/v1/lookup");
      reply.header("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(challenge)).toString("base64"));
      return reply.status(402).send({ ...challenge, reason: verification.reason });
    }

    // Verify alone only checks the signed authorization is well-formed and in
    // scope — it doesn't move funds. Settle before delivering so a paid
    // replay can never get the resource ahead of (or without) the on-chain
    // transfer actually landing.
    const settlement = await settlePayment(verification.payload, deps.x402);
    if (!settlement.settled) {
      const challenge = buildChallenge(deps.x402, "/v1/lookup");
      reply.header("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(challenge)).toString("base64"));
      return reply.status(402).send({ ...challenge, reason: settlement.reason });
    }
    reply.header(
      "X-PAYMENT-RESPONSE",
      Buffer.from(JSON.stringify({ success: true, transaction: settlement.txHash ?? null })).toString("base64")
    );

    return runLookup(deps, request.body, reply);
  });

  app.post("/v1/web/lookup", async (request, reply) => runLookup(deps, request.body, reply));
}

async function runLookup(deps: AppDeps, rawBody: unknown, reply: FastifyReply) {
  const parsed = LookupRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.message });
  }
  const body: LookupRequest = parsed.data;

  const candidates = await buildShortlist(deps, {
    taskSummary: body.task_summary,
    skillCategoryId: body.task_category ?? null,
    maxCandidates: body.max_candidates
  });

  const requestId = await persistAssessment(deps.db, {
    channel: "a2mcp",
    taskSummary: body.task_summary,
    skillCategoryId: body.task_category ?? null,
    acceptanceCriteria: null,
    requesterIdentifier: null,
    candidates,
    // Pay-per-call fee already settles via the 402 flow (or is unpaid for the human UI path) — not fee-on-success.
    feeStatus: "not_applicable"
  });

  const assessment: Assessment = {
    request_id: requestId,
    channel: "a2mcp",
    task_summary: body.task_summary,
    skill_category_id: body.task_category ?? null,
    acceptance_criteria: null,
    candidates
  };
  return reply.send(assessment);
}
