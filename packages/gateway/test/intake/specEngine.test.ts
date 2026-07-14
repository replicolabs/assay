import { describe, expect, it } from "vitest";
import { buildTaskSpec } from "../../src/intake/specEngine.js";
import type { LLMClient } from "../../src/intake/llmClient.js";

function fakeLlm(response: string): LLMClient {
  return { complete: async () => response };
}

describe("buildTaskSpec", () => {
  it("parses a clean JSON response", async () => {
    const spec = await buildTaskSpec(
      fakeLlm(
        JSON.stringify({
          skill_category_id: "code_generation.smart_contract_audit",
          acceptance_criteria: [{ id: "ac-1", description: "Report includes reentrancy analysis", testable: true }],
          clarifying_questions: []
        })
      ),
      "Audit my Anchor program"
    );
    expect(spec.skillCategoryId).toBe("code_generation.smart_contract_audit");
    expect(spec.acceptanceCriteria).toHaveLength(1);
    expect(spec.clarifyingQuestions).toEqual([]);
  });

  it("extracts JSON even when wrapped in prose/code fences", async () => {
    const spec = await buildTaskSpec(
      fakeLlm('Here you go:\n```json\n{"skill_category_id": "content.copywriting", "acceptance_criteria": [], "clarifying_questions": ["What tone?"]}\n```'),
      "Write me some copy"
    );
    expect(spec.skillCategoryId).toBe("content.copywriting");
    expect(spec.clarifyingQuestions).toEqual(["What tone?"]);
  });

  it("falls back to 'general' category when the field is missing", async () => {
    const spec = await buildTaskSpec(fakeLlm(JSON.stringify({ acceptance_criteria: [], clarifying_questions: [] })), "do a thing");
    expect(spec.skillCategoryId).toBe("general");
  });

  it("throws a clear error when the LLM response has no JSON at all", async () => {
    await expect(buildTaskSpec(fakeLlm("sorry, I can't help with that"), "x")).rejects.toThrow(/did not return parseable JSON/);
  });
});
