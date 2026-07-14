use std::time::Duration;

use assay_engine::{api, db, worker};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Loads the repo-root .env if present, resolved via CARGO_MANIFEST_DIR
    // (baked in at compile time) rather than a cwd-relative path — otherwise
    // this silently resolves to the wrong file depending on whether you run
    // `cargo run` from packages/engine/ or the repo root. Ok to ignore if
    // absent (real deployments set env vars directly); a genuine parse error
    // in an existing .env is NOT swallowed, so bad config still surfaces.
    let root_env_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env");
    match dotenvy::from_path(&root_env_path) {
        Ok(()) => {}
        Err(dotenvy::Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    // ENGINE_HTTP_ADDR wins when set (this service is private-only on Railway —
    // fixed at 0.0.0.0:8081 so the gateway's ENGINE_URL can hardcode the port over
    // the private network). Falls back to Railway's PORT convention, then a default,
    // so this also works unmodified on other PaaS that only inject PORT.
    let addr = std::env::var("ENGINE_HTTP_ADDR")
        .or_else(|_| std::env::var("PORT").map(|p| format!("0.0.0.0:{p}")))
        .unwrap_or_else(|_| "0.0.0.0:8081".to_string());
    let worker_interval_secs: u64 = std::env::var("ENGINE_WORKER_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);

    let pool = db::connect(&database_url).await?;
    db::migrate(&pool).await?;
    tracing::info!("migrations applied");

    let worker_pool = pool.clone();
    tokio::spawn(async move {
        worker::run(worker_pool, Duration::from_secs(worker_interval_secs)).await;
    });

    let app = api::router(pool);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "assay-engine listening");
    axum::serve(listener, app).await?;

    Ok(())
}
