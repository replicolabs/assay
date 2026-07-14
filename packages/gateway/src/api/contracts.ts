import { z } from "zod";

/**
 * Shared response contract between the gateway and the web frontend (and the
 * A2MCP/A2A JSON responses). Never a bare score (spec §2) — every candidate
 * carries fit reasoning, an evidence receipt, a stamped confidence bucket,
 * and engagement terms derived from that bucket.
 */

export const ConfidenceBucketSchema = z.enum(["unproven", "emerging", "proven", "high_confidence"]);
export type ConfidenceBucket = z.infer<typeof ConfidenceBucketSchema>;

export const EngagementTermsSchema = z.object({
  escrow_split: z.string(),
  milestone_structure: z.string(),
  holdback_pct: z.number(),
  require_stricter_acceptance_criteria: z.boolean()
});
export type EngagementTerms = z.infer<typeof EngagementTermsSchema>;

export const EvidenceSummarySchema = z.object({
  canary_score_this_category: z.number().nullable(),
  tasks_completed_this_category: z.number(),
  disputes_against: z.number(),
  consistency_variance: z.enum(["low", "medium", "high", "unknown"]),
  divergence_flag: z.boolean(),
  recent_vs_historical_delta: z.number().nullable()
});
export type EvidenceSummary = z.infer<typeof EvidenceSummarySchema>;

export const RankedCandidateSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  fit_reasoning: z.string(),
  evidence_summary: EvidenceSummarySchema,
  confidence_bucket: ConfidenceBucketSchema,
  score: z.number(),
  recommended_terms: EngagementTermsSchema
});
export type RankedCandidate = z.infer<typeof RankedCandidateSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  testable: z.boolean()
});

export const AssessmentSchema = z.object({
  request_id: z.string(),
  channel: z.enum(["a2mcp", "a2a"]),
  task_summary: z.string(),
  skill_category_id: z.string().nullable(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).nullable(),
  candidates: z.array(RankedCandidateSchema)
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const LookupRequestSchema = z.object({
  task_category: z.string().optional(),
  task_summary: z.string(),
  budget_hint: z.string().optional(),
  max_candidates: z.number().int().positive().max(20).default(5)
});
export type LookupRequest = z.infer<typeof LookupRequestSchema>;
