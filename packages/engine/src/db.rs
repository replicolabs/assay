//! Postgres access layer. Deliberately uses the *runtime*-checked `sqlx::query`
//! / `query_as` API (not the `query!`/`query_as!` compile-time macros) — those
//! macros need a live `DATABASE_URL` reachable at `cargo build` time, which
//! this dev environment doesn't have. Runtime checking is the right tradeoff
//! here anyway: it keeps `cargo build`/`cargo test` for the pure math modules
//! independent of any database being up.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{postgres::PgPoolOptions, FromRow, PgPool};
use uuid::Uuid;

/// Pool size is configurable (`MAX_DB_CONNECTIONS`, default 10 — sqlx's own
/// default) rather than hardcoded, since local dev against a lightweight
/// single-writer Postgres-wire server sometimes needs `1` where a real
/// multi-connection Postgres wouldn't.
pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    let max_connections: u32 = std::env::var("MAX_DB_CONNECTIONS").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    PgPoolOptions::new().max_connections(max_connections).connect(database_url).await
}

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("../../db/migrations").run(pool).await
}

#[derive(Debug, FromRow)]
pub struct SkillCategoryRow {
    pub id: String,
    pub decay_half_life_days: f64,
}

pub async fn get_skill_category(pool: &PgPool, id: &str) -> Result<Option<SkillCategoryRow>, sqlx::Error> {
    sqlx::query_as::<_, SkillCategoryRow>("select id, decay_half_life_days from skill_categories where id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}

#[derive(Debug, FromRow)]
pub struct ScoredPoint {
    pub score: f64,
    pub age_days: f64,
}

pub async fn canary_score_points(pool: &PgPool, agent_id: Uuid, skill_category_id: &str) -> Result<Vec<ScoredPoint>, sqlx::Error> {
    sqlx::query_as::<_, ScoredPoint>(
        "select score, extract(epoch from (now() - created_at)) / 86400.0 as age_days
         from canary_results
         where agent_id = $1 and skill_category_id = $2",
    )
    .bind(agent_id)
    .bind(skill_category_id)
    .fetch_all(pool)
    .await
}

#[derive(Debug, FromRow)]
pub struct OutcomeRow {
    pub resolution: String,
    pub requester_wallet_address: Option<String>,
    pub escrow_amount: Option<f64>,
    pub review_score: Option<f64>,
    pub age_days: f64,
}

pub async fn outcome_points(pool: &PgPool, agent_id: Uuid, skill_category_id: &str) -> Result<Vec<OutcomeRow>, sqlx::Error> {
    sqlx::query_as::<_, OutcomeRow>(
        "select resolution, requester_wallet_address, escrow_amount, review_score,
                extract(epoch from (now() - occurred_at)) / 86400.0 as age_days
         from outcome_ledger_entries
         where agent_id = $1 and (skill_category_id = $2 or skill_category_id is null)",
    )
    .bind(agent_id)
    .bind(skill_category_id)
    .fetch_all(pool)
    .await
}

pub async fn flagged_wallets(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_as::<_, (String,)>("select distinct wallet_address from sybil_wallet_clusters")
        .fetch_all(pool)
        .await
        .map(|rows| rows.into_iter().map(|(w,)| w).collect())
}

#[derive(Debug, FromRow)]
pub struct LatestConsistencyRun {
    pub stdev: Option<f64>,
}

pub async fn latest_consistency_run(pool: &PgPool, agent_id: Uuid, skill_category_id: &str) -> Result<Option<LatestConsistencyRun>, sqlx::Error> {
    sqlx::query_as::<_, LatestConsistencyRun>(
        "select stdev from consistency_runs
         where agent_id = $1 and skill_category_id = $2
         order by created_at desc limit 1",
    )
    .bind(agent_id)
    .bind(skill_category_id)
    .fetch_optional(pool)
    .await
}

pub struct CompositeScoreInsert {
    pub agent_id: Uuid,
    pub skill_category_id: String,
    pub score: f64,
    pub confidence_bucket: String,
    pub evidence_count: i32,
    pub canary_component: Option<f64>,
    pub outcome_component: Option<f64>,
    pub consistency_penalty: f64,
    pub divergence_flag: bool,
    pub recent_vs_historical_delta: Option<f64>,
}

pub async fn insert_composite_score(pool: &PgPool, row: &CompositeScoreInsert) -> Result<Uuid, sqlx::Error> {
    let (id,): (Uuid,) = sqlx::query_as(
        "insert into composite_scores
            (agent_id, skill_category_id, score, confidence_bucket, evidence_count,
             canary_component, outcome_component, consistency_penalty, divergence_flag, recent_vs_historical_delta)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id",
    )
    .bind(row.agent_id)
    .bind(&row.skill_category_id)
    .bind(row.score)
    .bind(&row.confidence_bucket)
    .bind(row.evidence_count)
    .bind(row.canary_component)
    .bind(row.outcome_component)
    .bind(row.consistency_penalty)
    .bind(row.divergence_flag)
    .bind(row.recent_vs_historical_delta)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

#[derive(Debug, FromRow, serde::Serialize)]
pub struct LatestCompositeScore {
    pub agent_id: Uuid,
    pub skill_category_id: String,
    pub score: f64,
    pub confidence_bucket: String,
    pub evidence_count: i32,
    pub divergence_flag: bool,
    pub computed_at: DateTime<Utc>,
}

pub async fn latest_composite_score(pool: &PgPool, agent_id: Uuid, skill_category_id: &str) -> Result<Option<LatestCompositeScore>, sqlx::Error> {
    sqlx::query_as::<_, LatestCompositeScore>(
        "select agent_id, skill_category_id, score, confidence_bucket, evidence_count, divergence_flag, computed_at
         from composite_scores
         where agent_id = $1 and skill_category_id = $2
         order by computed_at desc limit 1",
    )
    .bind(agent_id)
    .bind(skill_category_id)
    .fetch_optional(pool)
    .await
}

/// Distinct (agent_id, skill_category_id) pairs that have gained new canary or
/// outcome evidence since `since` — the background worker's recompute set.
pub async fn pairs_with_new_evidence(pool: &PgPool, since: DateTime<Utc>) -> Result<Vec<(Uuid, String)>, sqlx::Error> {
    sqlx::query_as::<_, (Uuid, String)>(
        "select distinct agent_id, skill_category_id from canary_results where created_at > $1
         union
         select distinct agent_id, coalesce(skill_category_id, '') from outcome_ledger_entries
         where occurred_at > $1 and skill_category_id is not null",
    )
    .bind(since)
    .fetch_all(pool)
    .await
}

#[derive(Debug, FromRow)]
pub struct CanaryTaskRow {
    pub id: Uuid,
    pub reference_output: Value,
    pub grading_mode: String,
}

pub async fn get_canary_task(pool: &PgPool, id: Uuid) -> Result<Option<CanaryTaskRow>, sqlx::Error> {
    sqlx::query_as::<_, CanaryTaskRow>("select id, reference_output, grading_mode from canary_tasks where id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}
