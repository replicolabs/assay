//! HTTP surface the gateway calls synchronously: on-demand scoring for the
//! A2MCP/A2A flows, canary grading right after a canary dispatch is delivered,
//! and consistency-variance computation for the top-N candidates in a deep
//! assessment.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{canary, composite, consistency, db, scoring, terms};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
}

pub fn router(pool: PgPool) -> Router {
    let state = Arc::new(AppState { pool });
    Router::new()
        .route("/healthz", get(healthz))
        .route("/score", post(score_handler))
        .route("/canary/grade", post(canary_grade_handler))
        .route("/consistency/variance", post(consistency_variance_handler))
        .with_state(state)
}

async fn healthz() -> &'static str {
    "ok"
}

enum ApiError {
    Db(sqlx::Error),
    BadRequest(String),
    NotFound(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::Db(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            ApiError::NotFound(m) => (StatusCode::NOT_FOUND, m),
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        ApiError::Db(e)
    }
}

// --- POST /score --------------------------------------------------------------

#[derive(Deserialize)]
struct ScoreRequest {
    agent_id: Uuid,
    skill_category_id: String,
}

#[derive(Serialize)]
struct ScoreResponse {
    agent_id: Uuid,
    skill_category_id: String,
    score: f64,
    confidence_bucket: composite::ConfidenceBucket,
    consistency_penalty: f64,
    divergence_flag: bool,
    recent_vs_historical_delta: Option<f64>,
    recommended_terms: terms::EngagementTerms,
}

async fn score_handler(State(state): State<Arc<AppState>>, Json(req): Json<ScoreRequest>) -> Result<Json<ScoreResponse>, ApiError> {
    let result = scoring::score_agent_category(&state.pool, req.agent_id, &req.skill_category_id).await?;

    let bucket_str = result.composite.confidence_bucket.as_str();
    let recommended_terms = terms::recommend(result.composite.confidence_bucket);

    db::insert_composite_score(
        &state.pool,
        &db::CompositeScoreInsert {
            agent_id: req.agent_id,
            skill_category_id: req.skill_category_id.clone(),
            score: result.composite.score,
            confidence_bucket: bucket_str.to_string(),
            evidence_count: 0, // effective (sybil-weighted) count is fractional; row keeps a display-friendly int separately if needed later
            canary_component: None,
            outcome_component: None,
            consistency_penalty: result.composite.consistency_penalty,
            divergence_flag: result.composite.divergence_flag,
            recent_vs_historical_delta: result.recent_vs_historical_delta,
        },
    )
    .await?;

    Ok(Json(ScoreResponse {
        agent_id: req.agent_id,
        skill_category_id: req.skill_category_id,
        score: result.composite.score,
        confidence_bucket: result.composite.confidence_bucket,
        consistency_penalty: result.composite.consistency_penalty,
        divergence_flag: result.composite.divergence_flag,
        recent_vs_historical_delta: result.recent_vs_historical_delta,
        recommended_terms,
    }))
}

// --- POST /canary/grade --------------------------------------------------------

#[derive(Deserialize)]
struct CanaryGradeRequest {
    canary_task_id: Uuid,
    dispatch_id: Uuid,
    agent_id: Uuid,
    skill_category_id: String,
    /// Shape depends on the task's grading_mode: exact/schema -> JSON object,
    /// numeric -> {"value": <number>}, rubric -> {"criteria_scores": [<number>...]}.
    output: Value,
}

#[derive(Serialize)]
struct CanaryGradeResponse {
    score: f64,
}

async fn canary_grade_handler(State(state): State<Arc<AppState>>, Json(req): Json<CanaryGradeRequest>) -> Result<Json<CanaryGradeResponse>, ApiError> {
    let task = db::get_canary_task(&state.pool, req.canary_task_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("canary_task not found".to_string()))?;

    let score = match task.grading_mode.as_str() {
        "exact" => canary::grade_exact(&req.output, &task.reference_output),
        "schema" => canary::grade_schema(&req.output, &task.reference_output),
        "numeric" => {
            let output_val = req.output.get("value").and_then(Value::as_f64);
            let reference_val = task.reference_output.get("value").and_then(Value::as_f64);
            let tolerance = task.reference_output.get("tolerance").and_then(Value::as_f64).unwrap_or(0.02);
            match (output_val, reference_val) {
                (Some(o), Some(r)) => canary::grade_numeric(o, r, tolerance),
                _ => return Err(ApiError::BadRequest("numeric grading requires {\"value\": <number>} on both output and reference_output".to_string())),
            }
        }
        "rubric" => {
            let scores: Vec<f64> = req
                .output
                .get("criteria_scores")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            canary::grade_rubric(&scores)
        }
        other => return Err(ApiError::BadRequest(format!("unknown grading_mode '{other}'"))),
    };

    sqlx::query(
        "insert into canary_results (dispatch_id, agent_id, skill_category_id, score, grading_detail) values ($1, $2, $3, $4, $5)",
    )
    .bind(req.dispatch_id)
    .bind(req.agent_id)
    .bind(&req.skill_category_id)
    .bind(score)
    .bind(&req.output)
    .execute(&state.pool)
    .await?;

    sqlx::query("update canary_dispatches set status = 'graded', graded_at = now() where id = $1")
        .bind(req.dispatch_id)
        .execute(&state.pool)
        .await?;

    Ok(Json(CanaryGradeResponse { score }))
}

// --- POST /consistency/variance -------------------------------------------------

#[derive(Deserialize)]
struct ConsistencyVarianceRequest {
    agent_id: Uuid,
    skill_category_id: String,
    dispatch_ids: Vec<Uuid>,
    scores: Vec<f64>,
}

#[derive(Serialize)]
struct ConsistencyVarianceResponse {
    mean: f64,
    variance: f64,
    stdev: f64,
    high_variance: bool,
    consistency_penalty: f64,
}

async fn consistency_variance_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ConsistencyVarianceRequest>,
) -> Result<Json<ConsistencyVarianceResponse>, ApiError> {
    let stats = consistency::compute(&req.scores).ok_or_else(|| ApiError::BadRequest("scores must be non-empty".to_string()))?;

    sqlx::query(
        "insert into consistency_runs (agent_id, skill_category_id, dispatch_ids, mean_score, variance, stdev) values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(req.agent_id)
    .bind(&req.skill_category_id)
    .bind(serde_json::to_value(&req.dispatch_ids).unwrap())
    .bind(stats.mean)
    .bind(stats.variance)
    .bind(stats.stdev)
    .execute(&state.pool)
    .await?;

    Ok(Json(ConsistencyVarianceResponse {
        mean: stats.mean,
        variance: stats.variance,
        stdev: stats.stdev,
        high_variance: consistency::is_high_variance(stats.stdev),
        consistency_penalty: consistency::consistency_penalty(stats.stdev),
    }))
}
