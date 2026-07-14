# Build context must be the repo root — this crate is one member of the Cargo
# workspace declared in the root Cargo.toml, and its sqlx::migrate!() call reads
# db/migrations via a path relative to this crate at *compile* time (the SQL gets
# embedded into the binary, so the runtime image doesn't need db/migrations at all).
#
# On Railway: Root Directory = "." (repo root), Dockerfile Path =
# "packages/engine/Dockerfile".

FROM rust:1.82-slim-bookworm AS builder
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY packages/engine/Cargo.toml packages/engine/Cargo.toml
COPY db/migrations db/migrations

# Cache dependency compilation separately from source changes so editing engine
# source doesn't re-download/re-build the whole dependency graph every time.
RUN mkdir -p packages/engine/src \
    && echo "fn main() {}" > packages/engine/src/main.rs \
    && cargo build --release -p assay-engine \
    && rm -rf packages/engine/src

COPY packages/engine/src packages/engine/src
RUN touch packages/engine/src/main.rs && cargo build --release -p assay-engine

FROM debian:bookworm-slim AS runtime
WORKDIR /app
# ca-certificates: required for TLS to Neon (rustls reads the system trust store).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/assay-engine /app/assay-engine

ENV RUST_LOG=info
CMD ["/app/assay-engine"]
