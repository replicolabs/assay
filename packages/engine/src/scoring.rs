//! Orchestration layer: pulls evidence rows out of Postgres, runs them through
//! the pure `recency`/`sybil`/`composite` modules, and returns a result ready
//! to persist. Kept separate from `db.rs` (I/O) and `composite.rs` (pure math)
//! so the math stays unit-testable without a database.

use std::collections::HashSet;

use sqlx::PgPool;
use uuid::Uuid;

use crate::{composite, db, recency, sybil};

pub struct ScoreResult {
    pub composite: composite::CompositeOutput,
    pub recent_vs_historical_delta: Option<f64>,
}

pub async fn score_agent_category(pool: &PgPool, agent_id: Uuid, skill_category_id: &str) -> Result<ScoreResult, sqlx::Error> {
    let half_life = db::get_skill_category(pool, skill_category_id)
        .await?
        .map(|c| c.decay_half_life_days)
        .unwrap_or(30.0);

    let canary_points = db::canary_score_points(pool, agent_id, skill_category_id).await?;
    let canary_component = recency::weighted_mean(
        &canary_points.iter().map(|p| (p.score, p.age_days)).collect::<Vec<_>>(),
        half_life,
    );

    let outcomes = db::outcome_points(pool, agent_id, skill_category_id).await?;
    let flagged: HashSet<String> = db::flagged_wallets(pool).await?.into_iter().collect();

    let scored_outcomes: Vec<(f64, f64, sybil::OutcomeSource)> = outcomes
        .iter()
        .map(|o| {
            let base = resolution_score(&o.resolution, o.review_score);
            let source = sybil::OutcomeSource {
                requester_wallet: o.requester_wallet_address.clone().unwrap_or_else(|| format!("unknown-{}", o.age_days)),
                escrow_amount: o.escrow_amount.unwrap_or(0.0),
            };
            (base, o.age_days, source)
        })
        .collect();

    let sybil_sources: Vec<sybil::OutcomeSource> = scored_outcomes.iter().map(|(_, _, s)| s.clone()).collect();
    let sybil_weights = sybil::diversity_weights(&sybil_sources, &flagged);

    let mut weighted_sum = 0.0;
    let mut weight_total = 0.0;
    for (i, (score, age_days, _)) in scored_outcomes.iter().enumerate() {
        let w = recency::decay_weight(*age_days, half_life) * sybil_weights.get(i).copied().unwrap_or(1.0);
        weighted_sum += score * w;
        weight_total += w;
    }
    let outcome_component = if weight_total > 0.0 { Some(weighted_sum / weight_total) } else { None };

    let effective_evidence_count = canary_points.len() as f64 + sybil::effective_evidence_count(&sybil_sources, &flagged);

    let consistency_stdev = db::latest_consistency_run(pool, agent_id, skill_category_id)
        .await?
        .and_then(|r| r.stdev);

    let recent_vs_historical_delta = compute_drift(&canary_points, half_life);

    let composite_out = composite::compute(composite::CompositeInput {
        canary_component,
        outcome_component,
        consistency_stdev,
        effective_evidence_count,
    });

    Ok(ScoreResult {
        composite: composite_out,
        recent_vs_historical_delta,
    })
}

/// Maps an outcome-ledger resolution to a 0..1 score. `released_clean` uses
/// the actual review score (0-5 stars) when present, since a clean release
/// with a mediocre review is a different signal than a clean release with a
/// glowing one; `disputed_for_agent` still costs something (friction/delay)
/// even though the agent ultimately won.
fn resolution_score(resolution: &str, review_score: Option<f64>) -> f64 {
    match resolution {
        "released_clean" => review_score.map(|s| (s / 5.0).clamp(0.0, 1.0)).unwrap_or(1.0),
        "disputed_for_agent" => 0.7,
        "disputed_against_agent" => 0.0,
        "abandoned" => 0.2,
        _ => 0.5,
    }
}

/// Compares a short-half-life recent window against a long-half-life
/// historical baseline — a proxy for "has this agent's canary performance
/// changed lately" (spec §5.3).
fn compute_drift(points: &[db::ScoredPoint], half_life: f64) -> Option<f64> {
    if points.is_empty() {
        return None;
    }
    let as_pairs: Vec<(f64, f64)> = points.iter().map(|p| (p.score, p.age_days)).collect();
    let recent_mean = recency::weighted_mean(&as_pairs, half_life / 3.0)?;
    let historical_mean = recency::weighted_mean(&as_pairs, half_life * 3.0)?;
    Some(recency::recent_vs_historical_delta(recent_mean, historical_mean))
}
