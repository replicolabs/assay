//! Background recompute: periodically re-scores every (agent, skill_category)
//! pair that has gained canary or outcome evidence since the last pass, so
//! composite scores stay decay-fresh even outside an active request (spec
//! §5.3's "recency weighting" and §5.1's "opportunistic background" pattern).

use std::time::Duration;

use chrono::Utc;
use sqlx::PgPool;
use tracing::{error, info};

use crate::{db, scoring};

pub async fn run(pool: PgPool, interval: Duration) {
    let mut last_run = Utc::now() - chrono::Duration::days(1);
    let mut ticker = tokio::time::interval(interval);

    loop {
        ticker.tick().await;
        let started_at = Utc::now();

        match db::pairs_with_new_evidence(&pool, last_run).await {
            Ok(pairs) => {
                info!(count = pairs.len(), "recomputing composite scores");
                for (agent_id, category_id) in pairs {
                    if category_id.is_empty() {
                        continue;
                    }
                    if let Err(e) = recompute_one(&pool, agent_id, &category_id).await {
                        error!(error = %e, %agent_id, category = %category_id, "failed to recompute composite score");
                    }
                }
            }
            Err(e) => error!(error = %e, "failed to list agent/category pairs with new evidence"),
        }

        last_run = started_at;
    }
}

async fn recompute_one(pool: &PgPool, agent_id: uuid::Uuid, category_id: &str) -> Result<(), sqlx::Error> {
    let result = scoring::score_agent_category(pool, agent_id, category_id).await?;
    db::insert_composite_score(
        pool,
        &db::CompositeScoreInsert {
            agent_id,
            skill_category_id: category_id.to_string(),
            score: result.composite.score,
            confidence_bucket: result.composite.confidence_bucket.as_str().to_string(),
            evidence_count: 0,
            canary_component: None,
            outcome_component: None,
            consistency_penalty: result.composite.consistency_penalty,
            divergence_flag: result.composite.divergence_flag,
            recent_vs_historical_delta: result.recent_vs_historical_delta,
        },
    )
    .await?;
    Ok(())
}
