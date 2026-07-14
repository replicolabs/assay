//! Recommended engagement terms are derived directly from the confidence
//! bucket (spec §5.6): high-confidence agents get lighter milestone
//! structuring and a larger up-front escrow release; low-confidence/unproven
//! agents get tighter milestones, a larger holdback, and stricter acceptance
//! criteria as a condition of the recommendation.

use crate::composite::ConfidenceBucket;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct EngagementTerms {
    /// "<upfront>/<holdback>" as whole percentages, e.g. "70/30".
    pub escrow_split: String,
    pub milestone_structure: String,
    pub holdback_pct: f64,
    pub require_stricter_acceptance_criteria: bool,
}

pub fn recommend(bucket: ConfidenceBucket) -> EngagementTerms {
    match bucket {
        ConfidenceBucket::HighConfidence => EngagementTerms {
            escrow_split: "70/30".to_string(),
            milestone_structure: "single_delivery".to_string(),
            holdback_pct: 0.30,
            require_stricter_acceptance_criteria: false,
        },
        ConfidenceBucket::Proven => EngagementTerms {
            escrow_split: "50/50".to_string(),
            milestone_structure: "single_delivery".to_string(),
            holdback_pct: 0.50,
            require_stricter_acceptance_criteria: false,
        },
        ConfidenceBucket::Emerging => EngagementTerms {
            escrow_split: "30/70".to_string(),
            milestone_structure: "two_milestone".to_string(),
            holdback_pct: 0.70,
            require_stricter_acceptance_criteria: true,
        },
        ConfidenceBucket::Unproven => EngagementTerms {
            escrow_split: "10/90".to_string(),
            milestone_structure: "milestone_per_deliverable".to_string(),
            holdback_pct: 0.90,
            require_stricter_acceptance_criteria: true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holdback_decreases_monotonically_with_confidence() {
        let unproven = recommend(ConfidenceBucket::Unproven).holdback_pct;
        let emerging = recommend(ConfidenceBucket::Emerging).holdback_pct;
        let proven = recommend(ConfidenceBucket::Proven).holdback_pct;
        let high = recommend(ConfidenceBucket::HighConfidence).holdback_pct;
        assert!(unproven > emerging);
        assert!(emerging > proven);
        assert!(proven > high);
    }

    #[test]
    fn low_confidence_requires_stricter_acceptance_criteria() {
        assert!(recommend(ConfidenceBucket::Unproven).require_stricter_acceptance_criteria);
        assert!(!recommend(ConfidenceBucket::HighConfidence).require_stricter_acceptance_criteria);
    }
}
