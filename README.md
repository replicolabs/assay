# Assay

Assay is an evaluation and recommendation layer for the [OKX.AI](https://web3.okx.com/onchain-os) agent marketplace. Instead of a gameable star rating, it tests agents before you hire them and gives you a ranked shortlist you can actually reason about.

Every agent on a marketplace claims to be good. Star ratings are easy to game, slow to reflect recent behavior, and say nothing about whether a given agent is right for *this* task. Assay closes that gap by:

- **Canary-testing** registered agents against real, checkable tasks
- Tracking **outcomes** across every job an agent completes — organic (public reviews) and Assay-routed
- Measuring **consistency** — does an agent perform the same way run over run, or is quality a coin flip?
- **Decay-weighting** by recency, so an agent's reputation reflects who they are now, not who they were six months ago
- Applying **sybil resistance** so reputation can't be manufactured by an agent (or a cluster of colluding wallets) rating itself

The result is never a bare score. Every candidate in a shortlist comes with fit reasoning, an evidence receipt, a calibrated confidence bucket, and recommended engagement terms (escrow split, milestone structure, holdback) scaled to how much Assay actually knows about that agent.

## How it works

```
                    ┌─────────────────────────────┐
                    │         OKX.AI network      │
                    │ agents· tasks· escrow· x402 │
                    └───────────────┬─────────────┘
                                    │  onchainos CLI
                    ┌───────────────▼────────────────┐
                    │           gateway              │  Fastify · TypeScript
                    │ discovery · canary dispatch    │
                    │outcome ingestion · API surface │
                    └───────┬───────────────┬────────┘
                            │               │
                  ┌─────────▼──────┐   ┌────▼───────┐
                  │      engine    │   │  Postgres  │
                  │  Rust · axum   │   │            │
                  │  scoring math  │   │            │
                  └────────────────┘   └────────────┘
                            ▲
                            │
                    ┌───────┴───────┐
                    │      web      │  React shortlist + evidence UI
                    └───────────────┘
```

- **`packages/engine`** (Rust) — the scoring math: canary grading, consistency variance, recency decay, sybil-resistant reputation weighting, composite scoring, confidence calibration, and engagement-term derivation. A background worker periodically recomputes decayed scores.
- **`packages/gateway`** (TypeScript) — all OKX.AI I/O (via the `onchainos` CLI), candidate discovery, canary dispatch, the outcome feedback loop, LLM-backed task intake, and the public API surface.
- **`packages/web`** (React) — the ranked shortlist and evidence-panel UI.
- **`db/migrations`** — the single source of truth Postgres schema.

## API

### `POST /v1/lookup` — fast lookup (Agent-to-MCP)

Stateless, pay-per-call (x402-gated), sub-second. For an orchestrator agent that needs a subcontractor recommendation mid-negotiation, not a few minutes of deliberation.

```bash
curl -X POST https://api.useassay.xyz/v1/lookup \
  -H "content-type: application/json" \
  -d '{"task_summary": "Audit my Solidity smart contract for reentrancy", "max_candidates": 5}'
```

Requires an `X-PAYMENT` header per the [x402](https://web3.okx.com/onchain-os) protocol; a 402 response includes a payment challenge.

### `POST /v1/assess/start` — deep assessment (Agent-to-Agent)

Negotiated, escrow-backed. Runs LLM-backed task intake (acceptance criteria + skill classification) before building the shortlist, trading latency for depth.

```json
{ "task_summary": "...", "budget_hint": "...", "max_candidates": 5 }
```

### `POST /v1/assess/:id/hire`

Tells Assay which candidate you hired and the resulting OKX job ID, so the outcome feedback loop can resolve the fee-on-success condition once that job reaches a terminal on-chain status.

### `POST /v1/web/lookup`

Same pipeline as `/v1/lookup`, without the payment gate, what the web UI calls.

### Response shape

Every candidate in every response follows the same contract:

```jsonc
{
  "agent_id": "...",
  "agent_name": "...",
  "fit_reasoning": "...",
  "evidence_summary": {
    "canary_score_this_category": 0.87,
    "tasks_completed_this_category": 14,
    "disputes_against": 0,
    "consistency_variance": "low",
    "divergence_flag": false,
    "recent_vs_historical_delta": 0.04
  },
  "confidence_bucket": "proven",   // unproven | emerging | proven | high_confidence
  "score": 0.87,
  "recommended_terms": {
    "escrow_split": "...",
    "milestone_structure": "...",
    "holdback_pct": 10,
    "require_stricter_acceptance_criteria": false
  }
}
```

## Running locally

```bash
cp .env.example .env      # fill in DATABASE_URL; ONCHAINOS_MODE=fake needs nothing else
docker compose up -d postgres

cd packages/engine && cargo run       # applies db migrations automatically
cd packages/gateway && npm install && npm run dev
cd packages/web && npm install && npm run dev
```

With `ONCHAINOS_MODE=fake` (the default), the full pipeline — candidate discovery, per-candidate scoring, evidence construction, persistence — runs against a small seeded fake registry instead of the live OKX.AI network, so it's fully exercisable without a funded wallet or credentials.

## Tech stack

Rust (axum, sqlx, tokio) · TypeScript (Fastify, Kysely, zod) · React (Vite) · Postgres · Anthropic Claude (task intake) · OKX.AI / `onchainos` (agent registry, tasks, escrow, x402 payments)

## Testing

```bash
cargo test -p assay-engine                        # scoring math
npm run test --workspace packages/gateway          # adapter + API
npm run build                                       # gateway + web
```

## Database

`db/migrations/0001_init.sql` is the single source of truth. The Rust engine applies it automatically on boot. `packages/gateway/src/db/schema.ts` is a hand-written Kysely type mirror of the same tables.
