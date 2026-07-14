//! Canary task grading: automated rubric scoring for checkable outputs
//! (code that must pass tests, structured data matching a schema, numerical
//! answers) — spec §5.1. Subjective-output canaries get a `Rubric` score
//! computed upstream (secondary review pass) and are just aggregated here.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GradingMode {
    Exact,
    Schema,
    Numeric,
    Rubric,
}

/// Exact match against the reference output. Score is binary: 1.0 or 0.0.
pub fn grade_exact(output: &Value, reference: &Value) -> f64 {
    if output == reference {
        1.0
    } else {
        0.0
    }
}

/// Fraction of the reference's required top-level keys present in `output`
/// with a matching JSON type (not matching value — schema conformance, not
/// content correctness).
pub fn grade_schema(output: &Value, reference: &Value) -> f64 {
    let Some(required) = reference.as_object() else {
        return 0.0;
    };
    if required.is_empty() {
        return 1.0;
    }
    let Some(actual) = output.as_object() else {
        return 0.0;
    };
    let matched = required
        .iter()
        .filter(|(key, expected_val)| {
            actual
                .get(*key)
                .is_some_and(|actual_val| std::mem::discriminant(*expected_val) == std::mem::discriminant(actual_val) || same_json_kind(expected_val, actual_val))
        })
        .count();
    matched as f64 / required.len() as f64
}

fn same_json_kind(a: &Value, b: &Value) -> bool {
    a.is_number() && b.is_number()
        || a.is_string() && b.is_string()
        || a.is_boolean() && b.is_boolean()
        || a.is_array() && b.is_array()
        || a.is_object() && b.is_object()
        || a.is_null() && b.is_null()
}

/// Numeric answer graded by relative error against a tolerance band — full
/// credit inside the tolerance, linear falloff to zero at 5x the tolerance.
pub fn grade_numeric(output: f64, reference: f64, tolerance: f64) -> f64 {
    let error = (output - reference).abs();
    let scale = reference.abs().max(1e-9);
    let relative_error = error / scale;
    if relative_error <= tolerance {
        1.0
    } else {
        let falloff_at = tolerance * 5.0;
        (1.0 - (relative_error - tolerance) / (falloff_at - tolerance)).clamp(0.0, 1.0)
    }
}

/// Rubric mode: aggregate pre-scored sub-criteria (each already 0..1) from an
/// automated check pass plus, when present, a lightweight human/LLM review pass.
pub fn grade_rubric(criteria_scores: &[f64]) -> f64 {
    if criteria_scores.is_empty() {
        return 0.0;
    }
    (criteria_scores.iter().sum::<f64>() / criteria_scores.len() as f64).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;
    use serde_json::json;

    #[test]
    fn exact_match_scores_one() {
        assert_relative_eq!(grade_exact(&json!({"a": 1}), &json!({"a": 1})), 1.0);
    }

    #[test]
    fn exact_mismatch_scores_zero() {
        assert_relative_eq!(grade_exact(&json!({"a": 1}), &json!({"a": 2})), 0.0);
    }

    #[test]
    fn schema_all_keys_present_scores_one() {
        let reference = json!({"title": "x", "amount": 1});
        let output = json!({"title": "audit report", "amount": 42, "extra": "ignored"});
        assert_relative_eq!(grade_schema(&output, &reference), 1.0);
    }

    #[test]
    fn schema_missing_key_scores_partial() {
        let reference = json!({"title": "x", "amount": 1});
        let output = json!({"title": "audit report"});
        assert_relative_eq!(grade_schema(&output, &reference), 0.5);
    }

    #[test]
    fn schema_wrong_type_not_counted() {
        let reference = json!({"amount": 1});
        let output = json!({"amount": "not a number"});
        assert_relative_eq!(grade_schema(&output, &reference), 0.0);
    }

    #[test]
    fn numeric_within_tolerance_scores_full() {
        assert_relative_eq!(grade_numeric(100.5, 100.0, 0.01), 1.0);
    }

    #[test]
    fn numeric_far_off_scores_near_zero() {
        let score = grade_numeric(1000.0, 100.0, 0.01);
        assert!(score < 0.1, "expected near-zero, got {score}");
    }

    #[test]
    fn numeric_falls_off_linearly_between_tolerance_and_cap() {
        let near = grade_numeric(101.5, 100.0, 0.01); // just past tolerance
        let far = grade_numeric(104.0, 100.0, 0.01); // near the falloff cap
        assert!(near > far);
        assert!(near < 1.0 && near > 0.0);
    }

    #[test]
    fn rubric_averages_subscores() {
        assert_relative_eq!(grade_rubric(&[1.0, 0.5, 0.0]), 0.5);
    }

    #[test]
    fn rubric_empty_scores_zero() {
        assert_relative_eq!(grade_rubric(&[]), 0.0);
    }
}
