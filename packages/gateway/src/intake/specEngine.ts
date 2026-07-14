import type { LLMClient } from "./llmClient.js";

/**
 * Task Intake & Spec Engine (spec §4.1): turns a raw task description into a
 * structured spec — skill category + testable acceptance criteria. A large
 * share of agent task failures happen because the request was underspecified,
 * not because the hired agent was incompetent (spec §3.6) — this is the
 * component that closes that gap. Used by the A2A deep-assessment path only;
 * the A2MCP fast path deliberately skips LLM latency (see assessmentService.ts).
 */

export interface AcceptanceCriterion {
  id: string;
  description: string;
  testable: boolean;
}

export interface TaskSpec {
  skillCategoryId: string;
  acceptanceCriteria: AcceptanceCriterion[];
  clarifyingQuestions: string[];
}

const SYSTEM_PROMPT = `You turn a vague marketplace task request into a structured spec for an agent-hiring evaluation service.
Output STRICT JSON only, matching this shape, no prose outside the JSON:
{
  "skill_category_id": "dot.separated.lowercase.slug",
  "acceptance_criteria": [{"id": "ac-1", "description": "...", "testable": true}],
  "clarifying_questions": ["..."]
}
Rules:
- skill_category_id should be a stable, reusable slug (e.g. "code_generation.smart_contract_audit", "content.copywriting", "data.etl_pipeline") — coarse enough to be reused across similar future tasks, specific enough to isolate meaningfully different skills.
- acceptance_criteria must be concrete and testable where possible (mark testable:false only for genuinely subjective criteria). Aim for 3-6 criteria.
- clarifying_questions should be empty unless the request is genuinely underspecified (missing budget-relevant scope, ambiguous deliverable format, unclear success condition). Do not ask questions that are answerable from the request text itself.`;

export async function buildTaskSpec(llm: LLMClient, taskSummary: string, budgetHint?: string): Promise<TaskSpec> {
  const prompt = `Task request: ${taskSummary}${budgetHint ? `\nBudget hint: ${budgetHint}` : ""}`;
  const raw = await llm.complete({ system: SYSTEM_PROMPT, prompt, maxTokens: 1024 });
  const parsed = parseJsonLoosely(raw);

  return {
    skillCategoryId: typeof parsed.skill_category_id === "string" && parsed.skill_category_id.length > 0 ? parsed.skill_category_id : "general",
    acceptanceCriteria: Array.isArray(parsed.acceptance_criteria)
      ? parsed.acceptance_criteria.map((c: unknown, i: number) => normalizeCriterion(c, i))
      : [],
    clarifyingQuestions: Array.isArray(parsed.clarifying_questions) ? parsed.clarifying_questions.filter((q: unknown): q is string => typeof q === "string") : []
  };
}

function normalizeCriterion(c: unknown, index: number): AcceptanceCriterion {
  const obj = typeof c === "object" && c !== null ? (c as Record<string, unknown>) : {};
  return {
    id: typeof obj.id === "string" ? obj.id : `ac-${index + 1}`,
    description: typeof obj.description === "string" ? obj.description : String(c),
    testable: typeof obj.testable === "boolean" ? obj.testable : true
  };
}

/** LLMs sometimes wrap JSON in prose or code fences despite instructions — extract the first {...} block. */
function parseJsonLoosely(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
    throw new Error(`LLM did not return parseable JSON for task spec: ${raw.slice(0, 500)}`);
  }
}
