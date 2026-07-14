//! Composite scoring & confidence calibration (spec §5.6). The whole point of
//! §2's design decision is that Assay never emits a bare score — this module
//! produces a score *and* a confidence bucket gated by evidence volume, so
//! "high score, two data points" and "high score, forty data points" can
//! never collapse into the same output.

use crate::consistency::consistency_penalty;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfidenceBucket {
    Unproven,
    Emerging,
    Proven,
    HighConfidence,
}

impl ConfidenceBucket {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConfidenceBucket::Unproven => "unproven",
            ConfidenceBucket::Emerging => "emerging",
            ConfidenceBucket::Proven => "proven",
            ConfidenceBucket::HighConfidence => "high_confidence",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CompositeInput {
    /// Decayed mean canary score, 0..1.
    pub canary_component: Option<f64>,
    /// Decayed, sybil-weighted outcome-ledger score, 0..1.
    pub outcome_component: Option<f64>,
    /// Latest consistency run's stdev, if one has been run recently.
    pub consistency_stdev: Option<f64>,
    /// Sybil-diversity-weighted evidence count feeding the confidence gate —
    /// NOT a raw row count (spec §9: gaming a few high-visibility outcomes
    /// must not be enough to reach "proven").
    pub effective_evidence_count: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct CompositeOutput {
    pub score: f64,
    pub confidence_bucket: ConfidenceBucket,
    pub consistency_penalty: f64,
    /// Canary and outcome evidence broadly disagree — surfaced as a flag
    /// rather than silently averaged away (spec §9).
    pub divergence_flag: bool,
}

const CANARY_WEIGHT: f64 = 0.45;
const OUTCOME_WEIGHT: f64 = 0.55;
const DIVERGENCE_THRESHOLD: f64 = 0.3;

const HIGH_CONFIDENCE_MIN_EVIDENCE: f64 = 30.0;
const PROVEN_MIN_EVIDENCE: f64 = 10.0;
const EMERGING_MIN_EVIDENCE: f64 = 3.0;

pub fn compute(input: CompositeInput) -> CompositeOutput {
    let (base_score, divergence_flag) = match (input.canary_component, input.outcome_component) {
        (Some(c), Some(o)) => (c * CANARY_WEIGHT + o * OUTCOME_WEIGHT, (c - o).abs() >= DIVERGENCE_THRESHOLD),
        (Some(c), None) => (c, false),
        (None, Some(o)) => (o, false),
        (None, None) => (0.0, false),
    };

    let penalty = input.consistency_stdev.map(consistency_penalty).unwrap_or(0.0);
    let score = (base_score * (1.0 - penalty)).clamp(0.0, 1.0);

    let has_any_evidence = input.canary_component.is_some() || input.outcome_component.is_some();
    let confidence_bucket = confidence_bucket_for(input.effective_evidence_count, has_any_evidence);

    CompositeOutput {
        score,
        confidence_bucket,
        consistency_penalty: penalty,
        divergence_flag,
    }
}

fn confidence_bucket_for(effective_evidence_count: f64, has_any_evidence: bool) -> ConfidenceBucket {
    if !has_any_evidence {
        return ConfidenceBucket::Unproven;
    }
    if effective_evidence_count >= HIGH_CONFIDENCE_MIN_EVIDENCE {
        ConfidenceBucket::HighConfidence
    } else if effective_evidence_count >= PROVEN_MIN_EVIDENCE {
        ConfidenceBucket::Proven
    } else if effective_evidence_count >= EMERGING_MIN_EVIDENCE {
        ConfidenceBucket::Emerging
    } else {
        ConfidenceBucket::Unproven
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(canary: Option<f64>, outcome: Option<f64>, stdev: Option<f64>, evidence: f64) -> CompositeInput {
        CompositeInput {
            canary_component: canary,
            outcome_component: outcome,
            consistency_stdev: stdev,
            effective_evidence_count: evidence,
        }
    }

    #[test]
    fn no_evidence_is_unproven_zero_score() {
        let out = compute(input(None, None, None, 0.0));
        assert_eq!(out.confidence_bucket, ConfidenceBucket::Unproven);
        assert_eq!(out.score, 0.0);
    }

    #[test]
    fn strong_agreement_high_evidence_is_high_confidence() {
        let out = compute(input(Some(0.9), Some(0.92), Some(0.05), 40.0));
        assert_eq!(out.confidence_bucket, ConfidenceBucket::HighConfidence);
        assert!(out.score > 0.8, "expected a high score, got {}", out.score);
        assert!(!out.divergence_flag);
    }

    #[test]
    fn high_score_but_thin_evidence_stays_unproven_or_emerging() {
        // Spec §9: raw score strength must never buy a confidence bucket on its own.
        let out = compute(input(Some(0.95), Some(0.95), Some(0.0), 2.0));
        assert_ne!(out.confidence_bucket, ConfidenceBucket::Proven);
        assert_ne!(out.confidence_bucket, ConfidenceBucket::HighConfidence);
    }

    #[test]
    fn sharp_disagreement_is_flagged() {
        let out = compute(input(Some(0.9), Some(0.2), Some(0.0), 20.0));
        assert!(out.divergence_flag);
    }

    #[test]
    fn agreement_within_threshold_not_flagged() {
        let out = compute(input(Some(0.7), Some(0.85), Some(0.0), 20.0));
        assert!(!out.divergence_flag);
    }

    #[test]
    fn high_variance_reduces_score_via_penalty() {
        let steady = compute(input(Some(0.8), Some(0.8), Some(0.0), 20.0));
        let volatile = compute(input(Some(0.8), Some(0.8), Some(0.4), 20.0));
        assert!(volatile.score < steady.score);
        assert!(volatile.consistency_penalty > 0.0);
    }

    #[test]
    fn single_source_evidence_still_scores() {
        let out = compute(input(Some(0.6), None, None, 5.0));
        assert!((out.score - 0.6).abs() < 1e-9);
        assert!(!out.divergence_flag);
    }
}
