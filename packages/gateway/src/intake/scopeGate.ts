import type { LLMClient } from "./llmClient.js";
import { parseJsonLoosely } from "./specEngine.js";

/**
 * Boundary testing (OKX's own "how to become A2A" guidance: "Verify whether
 * the Agent can politely decline or redirect tasks beyond its capabilities").
 * Assay's actual service is RECOMMENDING/RANKING other agents for a task —
 * it never performs the underlying task itself. A request asking Assay to
 * DO the work (write the contract, produce the content, run the trade) is
 * out of scope even if it superficially mentions "agents" or "evaluate".
 */

export interface ScopeDecision {
  inScope: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `You gate incoming task requests for Assay, an agent marketplace evaluation/recommendation service.

Assay's real service, in full: given a task description, evaluate and rank OTHER marketplace agents/vendors/candidates suited to that task, and deliver a shortlist with fit reasoning, evidence, confidence, generated acceptance criteria, and a recommended engagement plan (escrow split, milestones, terms). Generating acceptance criteria and an engagement/escrow plan is NOT out of scope — it is a core, advertised part of what Assay delivers, every time. Do not confuse "evaluate/rank the candidate vendors/agents and produce an engagement plan for hiring one" (Assay's actual product — IN SCOPE) with "personally perform the underlying task those vendors would be hired for" (OUT OF SCOPE).

Concretely IN SCOPE, even though it says "evaluate" or "assess":
- "Evaluate top 3 vendors for consistency, generate acceptance criteria, propose an engagement plan with escrow milestones" — this is a direct description of Assay's own product. In scope.
- "Assess candidates for a smart contract audit and recommend who to hire" — in scope (recommending an auditor, not auditing).
- "Rank agents for content writing" / "find the best agent for X" / "which agent should I hire for X" — in scope.

Concretely OUT OF SCOPE — the request asks Assay itself to produce the underlying deliverable, not a shortlist of who could:
- "Write me a Solidity staking contract" — in scope only if rephrased as finding who could write it; as asked, out of scope.
- "Audit my contract yourself and send me the report" — out of scope (audit performed by Assay, not a referral).
- "What is the price of ETH" / unrelated requests with no agent-hiring angle at all — out of scope.

When genuinely ambiguous, default to IN SCOPE — Assay's real product deliberately includes acceptance criteria and engagement/escrow planning, so most requests that mention those are legitimate, not exceptions.

Output STRICT JSON only, no prose outside the JSON:
{"in_scope": true|false, "reason": "one plain sentence, suitable to show the requester directly"}`;

/** Fail open (in_scope: true) on any parse/LLM failure — an unnecessary decline is worse than one extra evaluation running. */
export async function gateTaskScope(llm: LLMClient, taskDescription: string): Promise<ScopeDecision> {
  try {
    const raw = await llm.complete({ system: SYSTEM_PROMPT, prompt: `Task request: ${taskDescription}`, maxTokens: 256 });
    const parsed = parseJsonLoosely(raw);
    if (typeof parsed.in_scope !== "boolean") return { inScope: true, reason: "scope check response missing in_scope — proceeding" };
    return { inScope: parsed.in_scope, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch {
    return { inScope: true, reason: "scope check failed — proceeding" };
  }
}
