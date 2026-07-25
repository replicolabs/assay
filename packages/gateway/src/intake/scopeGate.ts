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

Assay's ONLY real service: given a task description, return a ranked shortlist of OTHER marketplace agents suited to that task, with fit reasoning, evidence, and confidence. Assay does NOT perform the underlying task itself — it never writes code, audits contracts, produces content, does research, executes trades, or delivers any work product other than a shortlist + evaluation.

Decide whether the request is asking Assay to RECOMMEND/EVALUATE/RANK agents for a task (in scope) versus asking Assay to DO that task directly, or something unrelated to agent evaluation entirely (out of scope).

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
