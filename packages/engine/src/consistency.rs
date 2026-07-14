//! Consistency testing: an agent with a good average but wide variance is
//! dangerous to hire, because a user hiring once experiences the variance they
//! drew, not the average (spec §5.3 / §3.4). This module measures spread, not
//! central tendency — central tendency is `recency::weighted_mean`'s job.

#[derive(Debug, Clone, PartialEq)]
pub struct ConsistencyStats {
    pub mean: f64,
    /// Sample variance (n-1 denominator); 0.0 when there's only one observation.
    pub variance: f64,
    pub stdev: f64,
}

pub fn compute(scores: &[f64]) -> Option<ConsistencyStats> {
    if scores.is_empty() {
        return None;
    }
    let n = scores.len() as f64;
    let mean = scores.iter().sum::<f64>() / n;
    let variance = if scores.len() < 2 {
        0.0
    } else {
        scores.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / (n - 1.0)
    };
    Some(ConsistencyStats {
        mean,
        variance,
        stdev: variance.sqrt(),
    })
}

/// Scores live on [0, 1], so a stdev above this is a wide spread worth flagging
/// in the confidence field even when the mean looks strong (spec §3.4).
pub const HIGH_VARIANCE_STDEV_THRESHOLD: f64 = 0.2;

pub fn is_high_variance(stdev: f64) -> bool {
    stdev >= HIGH_VARIANCE_STDEV_THRESHOLD
}

/// Penalty subtracted from the composite score for high variance, scaled
/// linearly and capped so a single wild outlier run can't zero out an
/// otherwise-strong composite score.
pub fn consistency_penalty(stdev: f64) -> f64 {
    (stdev * 1.5).min(0.5)
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn identical_scores_have_zero_variance() {
        let stats = compute(&[0.8, 0.8, 0.8]).unwrap();
        assert_relative_eq!(stats.variance, 0.0, epsilon = 1e-12);
        assert_relative_eq!(stats.mean, 0.8, epsilon = 1e-12);
    }

    #[test]
    fn single_score_has_zero_variance_not_none() {
        let stats = compute(&[0.5]).unwrap();
        assert_relative_eq!(stats.variance, 0.0, epsilon = 1e-12);
    }

    #[test]
    fn empty_scores_is_none() {
        assert_eq!(compute(&[]), None);
    }

    #[test]
    fn spread_scores_flagged_high_variance_even_with_good_mean() {
        // Mean is a respectable 0.7 but the agent swings from failing to perfect.
        let stats = compute(&[0.1, 0.9, 1.0, 0.8]).unwrap();
        assert!(stats.mean > 0.6);
        assert!(is_high_variance(stats.stdev), "stdev {} should be flagged", stats.stdev);
    }

    #[test]
    fn tight_scores_not_flagged() {
        let stats = compute(&[0.85, 0.88, 0.9, 0.87]).unwrap();
        assert!(!is_high_variance(stats.stdev));
    }

    #[test]
    fn penalty_is_capped() {
        assert!(consistency_penalty(10.0) <= 0.5);
    }
}
