# What this is

This directory holds proof of one real, on-chain, paid transaction executed by Assay's
own buyer identity against a real third-party agent on the live OKX.AI marketplace —
not a simulation, not fixture data, not a testnet. Real USDT, real gas, real XLayer
transactions.

- `deliverable.json` — the exact JSON payload returned by the third-party agent's API
  after payment.
- `manifest.json` — the local receipt `onchainos` itself generated for this job.

## What Assay actually is

Assay is an evaluation/recommendation layer for the OKX.AI agent marketplace. Instead of
trusting a gameable star rating, it's supposed to: canary-test registered agents against
real checkable tasks, track their outcomes over time, measure consistency across runs,
decay-weight by recency, apply sybil resistance, and hand a requester a ranked shortlist
of agents with fit reasoning, an evidence receipt, a confidence bucket, and recommended
engagement terms — never a bare score.

## What was actually tested here, step by step

This proved something narrower but still that Assay's own on-chain identity can 
actually transact on the real OKX.AI marketplace at all — discover a real agent, 
pay it for real, and receive a real deliverable back. Concretely:

1. **Deployed the real system.** Rust evaluation engine + TypeScript gateway, both
   running as separate services on Railway, talking to a production Postgres database
   and to each other over a private network. Verified first in "fake"
   mode (seeded fixture data, no live network) to confirm the deploy itself worked, then
   flipped to "live" mode.
2. **Logged into Assay's real OKX-managed wallet from inside the deployed container**,
   non-interactively, using only an API key/secret/passphrase. Confirmed this reached 
   the *same* account as the wallet used throughout development (`isNew: false`).
3. **Confirmed the live gateway can query the real marketplace** — a `/v1/web/lookup`
   call through the deployed service returned real agents (e.g. "SecureAudit AI,"
   "Praxis"), not fixture placeholders.
4. **Funded that wallet** with real money: bridged Solana USDC → XLayer USDC (via OKX
   Wallet's in-app bridge), then swapped USDC → USDT on XLayer (via `onchainos swap
   execute`, since the marketplace's task-escrow system only accepts USDT or USDG, not
   USDC) — a real on-chain DEX swap, $2 USDC in, $2.0057 USDT out.
5. **Attempted to route the test through Assay's own registered ASP identity first**
   (agent 5586) — blocked, because that listing is still stuck in OKX's manual approval
   queue (unrelated to anything Assay's code does; nothing we could fix from the CLI).
6. **Switched to a real, independent, live third-party agent instead**: found "SPOILER"
   (agent 3640) via a live marketplace search, picked its "Board Snapshot" service
   specifically because it required zero input parameters and was confirmed online as
   recently as the same day (lower risk of a dead/unresponsive endpoint for a one-shot
   test).
7. **Created a real on-chain task** designating SPOILER directly (`onchainos agent
   draft validate` → `draft create` → `draft publish`), budget 0.25–0.28 USDT.
8. **Paid for it via x402** — checked the endpoint's real payment challenge
   (`x402-check`), confirmed the `payTo` address matched SPOILER's actual registered
   wallet (not some unrelated address), then signed and broadcast the payment
   (`task-402-pay`), which atomically replayed the request against SPOILER's live
   endpoint (`https://spoiler.bet/api/v1/paid/board-snapshot`).
9. **Received a real deliverable back** — `deliverable.json` in this folder — and
   confirmed the wallet balance actually dropped by exactly 0.25 USDT.

Total real cost of this proof: **0.25 USDT** (paid to SPOILER) + a small amount of OKB
gas across the swap and the task transactions.

## What the output actually is

`deliverable.json` is SPOILER's own product output: a batch of "sealed" prediction-market
picks (Polymarket/Kalshi markets — e.g. "Bitcoin price on Jul 17, 2026," "World Cup
Winner"), each with a model win-probability, an "edge" figure, and a cryptographic
merkle-inclusion proof anchoring the pick to a specific XLayer transaction so it can be
verified as having been committed *before* the market resolved (a "no take-backs" proof
mechanism for a prediction-signal product). There's also a `proof_meter` summarizing
SPOILER's own historical grading record (70/100 graded picks, 60% win rate, running
PnL).

## Addendum: running the real deliverable through Assay's real code

After writing the section above, we went one step further: `assay_output.json` in this
folder is the output of `packages/engine/examples/score_spoiler_deliverable.rs`, which
calls Assay's actual `canary::grade_schema`, `composite::compute`, and `terms::recommend`
functions — not mocked, not hand-written — against the real `deliverable.json`. This is
the real `RankedCandidate` shape a requester would actually see.

Two honest things about it:

1. **The grading is real but minimal.** SPOILER's task was never given a formal
   acceptance schema when we created it (we only wrote a one-line description), so the
   schema used here — requiring a `proof_meter` object and a `receipts` array — was
   constructed after the fact, as a reasonable minimum bar for "a well-formed board
   snapshot." It graded 1.0 because the deliverable does contain both. This is a
   legitimate use of `grade_schema`, but it's a thin acceptance check, not a rich rubric.
2. **The confidence bucket is the actually meaningful result here.** Despite a perfect
   1.0 canary score, the output correctly comes back `"unproven"` — because
   `effective_evidence_count` is honestly `1.0` (this is the only canary Assay has ever
   run against this agent), and `composite.rs`'s evidence gate (tested explicitly:
   `high_score_but_thin_evidence_stays_unproven_or_emerging`) refuses to let one good
   result buy a confident rating. That refusal is the actual product working as
   designed — the exact thing that's supposed to distinguish Assay from a bare score.
