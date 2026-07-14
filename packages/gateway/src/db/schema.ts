import type { Generated } from "kysely";

/**
 * Kysely type-only schema mirroring db/migrations/0001_init.sql. Kept as a
 * hand-written mirror (not codegen) since the migration file is the single
 * source of truth and this file only needs to describe shapes, not generate
 * them — see README §Database for how to keep the two in sync.
 */


export interface SkillCategoriesTable {
  id: string;
  name: string;
  decay_half_life_days: number;
  created_at: Generated<Date>;
}

export interface AgentsTable {
  id: Generated<string>;
  okx_agent_id: string;
  name: string;
  role: "user" | "asp" | "evaluator";
  owner_address: string | null;
  status: "active" | "inactive" | "unknown";
  first_seen_at: Generated<Date>;
  last_synced_at: Generated<Date>;
}

export interface AgentServicesTable {
  id: Generated<string>;
  agent_id: string;
  okx_service_id: string | null;
  name: string;
  service_type: "a2a" | "a2mcp";
  fee_amount: number | null;
  fee_token: string | null;
  endpoint: string | null;
  description: string | null;
  skill_category_id: string | null;
  synced_at: Generated<Date>;
}

export interface CanaryTasksTable {
  id: Generated<string>;
  skill_category_id: string;
  prompt_payload: unknown; // jsonb
  reference_output: unknown; // jsonb
  grading_mode: "exact" | "schema" | "numeric" | "rubric";
  status: "active" | "rotated_out";
  last_rotated_at: Generated<Date>;
  created_at: Generated<Date>;
}

export interface CanaryDispatchesTable {
  id: Generated<string>;
  canary_task_id: string;
  agent_id: string;
  okx_job_id: string | null;
  status: "pending" | "published" | "delivered" | "graded" | "timed_out" | "failed";
  dispatched_at: Generated<Date>;
  delivered_at: Date | null;
  graded_at: Date | null;
}

export interface CanaryResultsTable {
  id: Generated<string>;
  dispatch_id: string;
  agent_id: string;
  skill_category_id: string;
  score: number;
  grading_detail: unknown;
  created_at: Generated<Date>;
}

export interface OutcomeLedgerEntriesTable {
  id: Generated<string>;
  agent_id: string;
  skill_category_id: string | null;
  okx_job_id: string | null;
  source: "routed" | "organic_feedback";
  requester_wallet_address: string | null;
  resolution: "released_clean" | "disputed_for_agent" | "disputed_against_agent" | "abandoned";
  escrow_amount: number | null;
  escrow_token: string | null;
  review_score: number | null;
  occurred_at: Date;
  created_at: Generated<Date>;
}

export interface SybilWalletClustersTable {
  id: Generated<string>;
  cluster_key: string;
  wallet_address: string;
  heuristic: string;
  detected_at: Generated<Date>;
}

export interface ConsistencyRunsTable {
  id: Generated<string>;
  agent_id: string;
  skill_category_id: string;
  dispatch_ids: unknown; // jsonb array
  mean_score: number | null;
  variance: number | null;
  stdev: number | null;
  created_at: Generated<Date>;
}

export interface CompositeScoresTable {
  id: Generated<string>;
  agent_id: string;
  skill_category_id: string;
  score: number;
  confidence_bucket: "unproven" | "emerging" | "proven" | "high_confidence";
  evidence_count: number;
  canary_component: number | null;
  outcome_component: number | null;
  consistency_penalty: number | null;
  divergence_flag: boolean;
  recent_vs_historical_delta: number | null;
  computed_at: Generated<Date>;
}

export interface AssessmentsTable {
  id: Generated<string>;
  channel: "a2mcp" | "a2a";
  task_summary: string;
  skill_category_id: string | null;
  acceptance_criteria: unknown;
  requester_identifier: string | null;
  ranked_candidates: unknown;
  fee_status: "pending" | "released" | "not_applicable";
  routed_job_id: string | null;
  created_at: Generated<Date>;
  resolved_at: Date | null;
}

export interface Database {
  skill_categories: SkillCategoriesTable;
  agents: AgentsTable;
  agent_services: AgentServicesTable;
  canary_tasks: CanaryTasksTable;
  canary_dispatches: CanaryDispatchesTable;
  canary_results: CanaryResultsTable;
  outcome_ledger_entries: OutcomeLedgerEntriesTable;
  sybil_wallet_clusters: SybilWalletClustersTable;
  consistency_runs: ConsistencyRunsTable;
  composite_scores: CompositeScoresTable;
  assessments: AssessmentsTable;
}
