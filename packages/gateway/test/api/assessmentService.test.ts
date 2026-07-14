import { describe, expect, it } from "vitest";
import { buildFitReasoning } from "../../src/api/assessmentService.js";
import type { CandidateAgent } from "../../src/okx/registry.js";
import type { ScoreResponse } from "../../src/engine/engineClient.js";

const candidate: CandidateAgent = {
  okxAgentId: "1001",
  name: "SolWatch Auditor",
  services: [{ serviceId: "svc-1", name: "Smart Contract Audit", serviceType: "a2a", fee: "20", endpoint: null, description: null }],
  discoveredVia: "asp_match"
};

function score(overrides: Partial<ScoreResponse> = {}): ScoreResponse {
  return {
    agent_id: "uuid",
    skill_category_id: "code_generation.smart_contract_audit",
    score: 0.8,
    confidence_bucket: "proven",
    consistency_penalty: 0,
    divergence_flag: false,
    recent_vs_historical_delta: null,
    recommended_terms: { escrow_split: "50/50", milestone_structure: "single_delivery", holdback_pct: 0.5, require_stricter_acceptance_criteria: false },
    ...overrides
  };
}

describe("buildFitReasoning", () => {
  it("mentions the matched service and confidence bucket", () => {
    const reasoning = buildFitReasoning(candidate, score());
    expect(reasoning).toContain("Smart Contract Audit");
    expect(reasoning).toContain("proven");
  });

  it("surfaces a divergence warning when sources disagree", () => {
    const reasoning = buildFitReasoning(candidate, score({ divergence_flag: true }));
    expect(reasoning).toMatch(/disagree/i);
  });

  it("surfaces a drift note on a significant recent-vs-historical delta", () => {
    const reasoning = buildFitReasoning(candidate, score({ recent_vs_historical_delta: 0.3 }));
    expect(reasoning).toMatch(/shifted up/i);
  });

  it("stays quiet about drift for a small delta", () => {
    const reasoning = buildFitReasoning(candidate, score({ recent_vs_historical_delta: 0.02 }));
    expect(reasoning).not.toMatch(/shifted/i);
  });
});
