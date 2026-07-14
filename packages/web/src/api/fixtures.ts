import type { Assessment } from "../../../gateway/src/api/contracts";

/**
 * Hand-written fixtures matching AssessmentSchema exactly. Used by the mock
 * data path in client.ts (see fetchAssessment) so the UI can be reviewed
 * without the gateway's HTTP endpoints wired up yet.
 *
 * Deliberately varied: different confidence buckets, different candidate
 * counts, one candidate with divergence_flag true, one with high
 * consistency_variance, and a mix of populated / null evidence fields.
 */

const solidityAudit: Assessment = {
  request_id: "req_9f1c3e2a",
  channel: "a2mcp",
  task_summary:
    "Audit a 900-line Solidity vault contract for reentrancy and access-control bugs before mainnet deploy.",
  skill_category_id: "smart-contract-audit",
  acceptance_criteria: [
    { id: "ac_1", description: "Findings categorized by severity (critical/high/medium/low).", testable: true },
    { id: "ac_2", description: "Each finding includes a proof-of-concept or exploit trace.", testable: true },
    { id: "ac_3", description: "Report delivered as a single reviewable document within 48h.", testable: true }
  ],
  candidates: [
    {
      agent_id: "agt_forge_sentinel",
      agent_name: "Forge Sentinel",
      fit_reasoning:
        "Forge Sentinel has completed 41 audits in this exact category with zero disputed findings, and its last 10 canary runs on reentrancy-class bugs scored above 90. Its output style matches the acceptance criteria here almost exactly — severity-tagged findings with PoC traces are its default report format, not an add-on.",
      evidence_summary: {
        canary_score_this_category: 94,
        tasks_completed_this_category: 41,
        disputes_against: 0,
        consistency_variance: "low",
        divergence_flag: false,
        recent_vs_historical_delta: 1.2
      },
      confidence_bucket: "high_confidence",
      score: 0.96,
      recommended_terms: {
        escrow_split: "30% upfront / 70% on delivery",
        milestone_structure: "Single milestone — full report accepted or revised once at no extra cost.",
        holdback_pct: 0,
        require_stricter_acceptance_criteria: false
      }
    },
    {
      agent_id: "agt_ledger_scope",
      agent_name: "LedgerScope",
      fit_reasoning:
        "LedgerScope is proven in general Solidity review work, but only 6 of its 52 completed tasks were vault/reentrancy-specific, and canary coverage for that narrower slice is thinner. Two independent evaluation runs disagree meaningfully on its reentrancy-detection recall, so treat the headline number with caution.",
      evidence_summary: {
        canary_score_this_category: 71,
        tasks_completed_this_category: 6,
        disputes_against: 1,
        consistency_variance: "high",
        divergence_flag: true,
        recent_vs_historical_delta: -8.4
      },
      confidence_bucket: "emerging",
      score: 0.64,
      recommended_terms: {
        escrow_split: "50% upfront / 50% on delivery",
        milestone_structure: "Two milestones — draft findings review, then final report with PoCs.",
        holdback_pct: 15,
        require_stricter_acceptance_criteria: true
      }
    },
    {
      agent_id: "agt_pale_auditor",
      agent_name: "Pale Auditor",
      fit_reasoning:
        "Pale Auditor registered for this skill category recently and has no completed tasks or canary runs on record yet. It's included because its stated capabilities match the request, but there is no outcome data to back that claim — treat this as speculative until it earns a track record.",
      evidence_summary: {
        canary_score_this_category: null,
        tasks_completed_this_category: 0,
        disputes_against: 0,
        consistency_variance: "unknown",
        divergence_flag: false,
        recent_vs_historical_delta: null
      },
      confidence_bucket: "unproven",
      score: 0.22,
      recommended_terms: {
        escrow_split: "10% upfront / 90% on delivery",
        milestone_structure: "Full holdback until an independent second reviewer confirms the findings.",
        holdback_pct: 40,
        require_stricter_acceptance_criteria: true
      }
    }
  ]
};

const copyEditing: Assessment = {
  request_id: "req_3b7a0d19",
  channel: "a2a",
  task_summary: "Copy-edit a 12-page grant proposal for tone, clarity, and consistency before Friday's submission deadline.",
  skill_category_id: "editorial-copyediting",
  acceptance_criteria: [
    { id: "ac_1", description: "Tracked changes preserved in the returned document.", testable: true },
    { id: "ac_2", description: "Terminology consistent with the supplied style sheet.", testable: true }
  ],
  candidates: [
    {
      agent_id: "agt_marginal_press",
      agent_name: "Marginal Press",
      fit_reasoning:
        "Marginal Press has a solid, if unspectacular, record on long-form editorial tasks — consistent turnaround and no disputes, though its canary scores for grant-proposal tone specifically (rather than general copy) sit in the middle of the pack and haven't moved much recently.",
      evidence_summary: {
        canary_score_this_category: 78,
        tasks_completed_this_category: 19,
        disputes_against: 0,
        consistency_variance: "medium",
        divergence_flag: false,
        recent_vs_historical_delta: 0.6
      },
      confidence_bucket: "proven",
      score: 0.81,
      recommended_terms: {
        escrow_split: "40% upfront / 60% on delivery",
        milestone_structure: "Single milestone — tracked-changes draft returned, one revision round included.",
        holdback_pct: 10,
        require_stricter_acceptance_criteria: false
      }
    },
    {
      agent_id: "agt_redline_atelier",
      agent_name: "Redline Atelier",
      fit_reasoning:
        "Redline Atelier is the strongest available match: a deep task history in exactly this category, a canary score that has climbed over its last several evaluation cycles, and no disputes on record.",
      evidence_summary: {
        canary_score_this_category: 91,
        tasks_completed_this_category: 63,
        disputes_against: 0,
        consistency_variance: "low",
        divergence_flag: false,
        recent_vs_historical_delta: 4.1
      },
      confidence_bucket: "high_confidence",
      score: 0.93,
      recommended_terms: {
        escrow_split: "50% upfront / 50% on delivery",
        milestone_structure: "Single milestone — final document delivered against the style sheet.",
        holdback_pct: 0,
        require_stricter_acceptance_criteria: false
      }
    }
  ]
};

const dataPipeline: Assessment = {
  request_id: "req_7e2d4c88",
  channel: "a2mcp",
  task_summary: "Build a nightly ETL job that reconciles two upstream inventory feeds and flags mismatches over 2%.",
  skill_category_id: "data-engineering",
  acceptance_criteria: null,
  candidates: [
    {
      agent_id: "agt_quiet_cistern",
      agent_name: "Quiet Cistern",
      fit_reasoning:
        "Quiet Cistern has never taken a task in this category and declined its last two assigned canary runs without completing them, so there is effectively no signal to evaluate fit on beyond its self-reported capabilities.",
      evidence_summary: {
        canary_score_this_category: null,
        tasks_completed_this_category: 0,
        disputes_against: 0,
        consistency_variance: "unknown",
        divergence_flag: false,
        recent_vs_historical_delta: null
      },
      confidence_bucket: "unproven",
      score: 0.11,
      recommended_terms: {
        escrow_split: "0% upfront / 100% on delivery",
        milestone_structure: "Full holdback — pay only after the reconciliation job runs successfully against sample data.",
        holdback_pct: 50,
        require_stricter_acceptance_criteria: true
      }
    }
  ]
};

export const FIXTURES: Record<string, Assessment> = {
  solidity_audit: solidityAudit,
  copy_editing: copyEditing,
  data_pipeline: dataPipeline
};

export const DEFAULT_FIXTURE = solidityAudit;

/** Loosely match a fixture to the free-text task summary so the demo feels responsive. */
export function pickFixtureFor(taskSummary: string): Assessment {
  const t = taskSummary.toLowerCase();
  if (t.includes("audit") || t.includes("solidity") || t.includes("contract") || t.includes("vault")) {
    return solidityAudit;
  }
  if (t.includes("edit") || t.includes("copy") || t.includes("proposal") || t.includes("writ")) {
    return copyEditing;
  }
  if (t.includes("etl") || t.includes("pipeline") || t.includes("data") || t.includes("reconcil")) {
    return dataPipeline;
  }
  return DEFAULT_FIXTURE;
}
