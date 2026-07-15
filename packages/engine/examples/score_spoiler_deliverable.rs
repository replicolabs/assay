//! Runs Assay's *actual* canary-grading and composite-scoring code (not a
//! mock, not hand-computed) against the real deliverable SPOILER returned in
//! proof/deliverable.json, to show the real RankedCandidate-shaped output
//! Assay would have produced — as opposed to the raw third-party payload
//! that deliverable.json is, which is what a requester never actually sees.
//!
//! Run from packages/engine: `cargo run --example score_spoiler_deliverable`

use assay_engine::{canary, composite, terms};
use serde_json::json;

fn main() {
    let deliverable_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../proof/deliverable.json");
    let deliverable: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(deliverable_path).expect("read proof/deliverable.json — run from packages/engine")).unwrap();

    // A genuine (if minimal) acceptance schema for this canary: a well-formed
    // board-snapshot deliverable must have a proof_meter object and a receipts
    // array. Nothing about SPOILER's actual pick content is graded — Assay
    // never had reference data to check picks against, only structure.
    let reference_schema = json!({
        "proof_meter": {},
        "receipts": []
    });

    let canary_score = canary::grade_schema(&deliverable, &reference_schema);

    // Honest inputs: this is the *only* data point Assay has ever collected on
    // agent 3640. No outcome-ledger history, no prior canaries, no consistency
    // runs across repeat calls — real evidence count is 1, not "a lot."
    let composite_input = composite::CompositeInput {
        canary_component: Some(canary_score),
        outcome_component: None,
        consistency_stdev: None,
        effective_evidence_count: 1.0,
    };
    let result = composite::compute(composite_input);
    let recommended_terms = terms::recommend(result.confidence_bucket);

    // The actual RankedCandidate shape (packages/gateway/src/api/contracts.ts)
    // that Assay's API would return to a requester.
    let ranked_candidate = json!({
        "agent_id": "3640",
        "agent_name": "SPOILER",
        "fit_reasoning": format!(
            "This is the only canary Assay has ever run against agent 3640 (SPOILER). \
             The deliverable was structurally well-formed (schema score {:.2}), but one \
             data point is not evidence of anything repeatable — this candidate has not \
             earned a confidence rating yet.",
            canary_score
        ),
        "evidence_summary": {
            "canary_score_this_category": canary_score,
            "tasks_completed_this_category": 1,
            "disputes_against": 0,
            "consistency_variance": "unknown",
            "divergence_flag": result.divergence_flag,
            "recent_vs_historical_delta": null
        },
        "confidence_bucket": result.confidence_bucket.as_str(),
        "score": result.score,
        "recommended_terms": recommended_terms
    });

    println!("{}", serde_json::to_string_pretty(&ranked_candidate).unwrap());
}
