import { describe, expect, it } from "vitest";
import { gateTaskScope } from "../../src/intake/scopeGate.js";
import type { LLMClient } from "../../src/intake/llmClient.js";

function fakeLlm(response: string): LLMClient {
  return { complete: async () => response };
}

function throwingLlm(): LLMClient {
  return {
    complete: async () => {
      throw new Error("boom");
    }
  };
}

describe("gateTaskScope", () => {
  it("accepts a task asking Assay to recommend/rank agents", async () => {
    const decision = await gateTaskScope(
      fakeLlm(JSON.stringify({ in_scope: true, reason: "This asks Assay to shortlist agents for a smart contract audit." })),
      "Find me the best agent to audit my Anchor program"
    );
    expect(decision.inScope).toBe(true);
  });

  it("declines a task asking Assay to perform the work itself", async () => {
    const decision = await gateTaskScope(
      fakeLlm(JSON.stringify({ in_scope: false, reason: "This asks Assay to write the smart contract directly, not recommend who should." })),
      "Write me a Solidity staking contract"
    );
    expect(decision.inScope).toBe(false);
    expect(decision.reason).toMatch(/write the smart contract/);
  });

  it("fails open (in scope) when the LLM call throws", async () => {
    const decision = await gateTaskScope(throwingLlm(), "anything");
    expect(decision.inScope).toBe(true);
  });

  it("fails open when the response has no parseable JSON", async () => {
    const decision = await gateTaskScope(fakeLlm("I'm not sure how to answer that"), "anything");
    expect(decision.inScope).toBe(true);
  });

  it("fails open when in_scope is missing from an otherwise-valid JSON response", async () => {
    const decision = await gateTaskScope(fakeLlm(JSON.stringify({ reason: "no in_scope field" })), "anything");
    expect(decision.inScope).toBe(true);
  });
});
