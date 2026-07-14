//! Exponential recency decay. All evidence inputs to the composite score
//! (canary results, outcome ledger entries, consistency runs) get decayed by
//! age before aggregation — an agent that was excellent six months ago and has
//! since drifted should not coast on old performance (spec §5.3).

/// Weight of a data point `age_days` old, given a category's `half_life_days`.
/// At `age_days == half_life_days` the weight is exactly 0.5.
pub fn decay_weight(age_days: f64, half_life_days: f64) -> f64 {
    if half_life_days <= 0.0 {
        return if age_days <= 0.0 { 1.0 } else { 0.0 };
    }
    0.5_f64.powf(age_days.max(0.0) / half_life_days)
}

/// Decay-weighted mean of `(value, age_days)` pairs. `None` if the slice is empty
/// or every weight underflows to zero.
pub fn weighted_mean(points: &[(f64, f64)], half_life_days: f64) -> Option<f64> {
    let mut weighted_sum = 0.0;
    let mut weight_total = 0.0;
    for &(value, age_days) in points {
        let w = decay_weight(age_days, half_life_days);
        weighted_sum += value * w;
        weight_total += w;
    }
    if weight_total <= 0.0 {
        None
    } else {
        Some(weighted_sum / weight_total)
    }
}

/// Sharp divergence between a decayed *recent* window mean and the full decayed
/// historical mean is itself a signal (possible degradation/model swap/compromise,
/// spec §5.3) — this does not judge good/bad, just flags disagreement.
pub fn recent_vs_historical_delta(recent_mean: f64, historical_mean: f64) -> f64 {
    recent_mean - historical_mean
}

pub fn is_significant_drift(delta: f64, threshold: f64) -> bool {
    delta.abs() >= threshold
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn half_life_gives_half_weight() {
        assert_relative_eq!(decay_weight(30.0, 30.0), 0.5, epsilon = 1e-9);
    }

    #[test]
    fn zero_age_gives_full_weight() {
        assert_relative_eq!(decay_weight(0.0, 30.0), 1.0, epsilon = 1e-9);
    }

    #[test]
    fn weight_decays_further_with_more_age() {
        assert!(decay_weight(90.0, 30.0) < decay_weight(30.0, 30.0));
    }

    #[test]
    fn weighted_mean_favors_recent_points() {
        // Old point scores 0.0, recent point scores 1.0 — with strong decay the
        // mean should sit much closer to 1.0 than a flat average (0.5) would.
        let points = [(0.0, 365.0), (1.0, 1.0)];
        let mean = weighted_mean(&points, 30.0).unwrap();
        assert!(mean > 0.9, "expected recency-dominated mean, got {mean}");
    }

    #[test]
    fn empty_points_returns_none() {
        assert_eq!(weighted_mean(&[], 30.0), None);
    }

    #[test]
    fn drift_detection_respects_threshold() {
        assert!(is_significant_drift(0.4, 0.3));
        assert!(!is_significant_drift(0.2, 0.3));
    }
}
