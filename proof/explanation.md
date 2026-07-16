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

## Second real test: the escrow/A2A path, through the actual dispatcher code

The first test above deliberately bypassed Assay's own gateway code — every step was a
CLI command run by hand. This second test closes that gap for one payment mode: a real
canary was dispatched through `packages/gateway/src/canary/dispatcher.ts` itself
(`dispatchCanary` / `gradeDispatch`), not by hand, against **TaskScout AI** (a real,
independent, live agent — "Task Difficulty Analyzer" service, 0.02 USDT, A2A/escrow, not
Assay's own ASP identity, which is still stuck in OKX's listing review).

Getting this working surfaced and fixed four real gaps in the code before any money
moved, then two more real ones live:

- `dispatchCanary` previously hardcoded `paymentMode: "escrow"` and had no path for
  A2MCP/x402 targets at all — fixed with a real branch that checks the target service's
  actual type and picks the right protocol.
- `serviceId` was typed optional but is actually required by the live API — now enforced
  with a clear error before any network call.
- Nothing anywhere in the codebase ever called `client.complete()` — a canary could be
  graded and the ASP would simply never get paid. Fixed.
- No check existed for whether the designated agent was actually online before spending
  into a dispatch.
- **Live-only discovery**: `agent create-task` returns human-readable console text, not
  JSON, when called directly — this actually broadcast a real on-chain task successfully
  before the client crashed trying to parse it, orphaning the task from Assay's DB. Fixed
  by routing through `draft create` → `draft publish` instead (proven to return clean
  JSON). The orphaned real task was manually reconciled into the DB rather than
  duplicated.
- **Live-only discovery**: `service-list`'s real response wraps `{agentInfo, list}` in an
  array (`data: [{...}]`), not the bare object the schema assumed — this exact method had
  never actually been exercised through the real client against live data before this
  run. Fixed.

### What "grading a real A2A submission" actually required

This is the bigger finding. `task-deliverable-list` — the mechanism `gradeDispatch`
relies on — came back empty for this real submission, even after TaskScout AI's status
moved to `submitted`. The actual deliverable was sitting in a completely separate system:
OKX.AI's A2A messaging layer, XMTP-based, accessed through the **`okx-a2a`** CLI (a
different binary from `onchainos`), as an encrypted file attachment
(`okx-a2a task requests` → `okx-a2a file download` with a fileKey/digest/salt/nonce/secret).
`gradeDispatch` as written has no code path to this at all — it only knows about
`onchainos`'s simpler deliverable mechanism, which appears to be x402/A2MCP-specific (x402
embeds the deliverable directly in the payment response, which is why the first test never
hit this).

Once retrieved and decrypted, the deliverable (`a2a-escrow-deliverable.md` in this folder)
turned out to be genuinely good, substantive work — a real difficulty analysis of the task
description we wrote, correctly covering data sources, ambiguity, dispute risk, effort
estimate, and acceptance probability, matching exactly what the service's own listing
promised.

Releasing payment surfaced one more real requirement: `client.complete()` refuses to run
directly for escrow tasks — it requires a "review-gate" that only gets set after an
explicit human-approved review flow (`onchainos agent next-action` with `event=job_submitted`
→ `pending-decisions-v2 request` → the user's actual reply relayed back through a specific
event chain → `next-action` with `event=approve_review`). This isn't a bug, it's a genuine
safety mechanism preventing an agent from unilaterally releasing a buyer's funds — but it's
a real, undocumented dependency `gradeDispatch` doesn't know how to drive today.

**Result**: task status moved to `complete`, wallet balance dropped by exactly 0.02 USDT,
confirmed on-chain.

### What this does prove

A canary can be dispatched, accepted, delivered, graded, and paid
through Assay's actual dispatcher code (not hand-run CLI) for the escrow/A2A path,
end to end, including a real human-approval gate.

## Fourth real test round: closing every gap on the list above

Every item in the "not proven" list above except two has since been closed with real code
and real live execution — not just fixed and unit-tested, but actually re-run against the
live network and the production database.

**A2A deliverable retrieval was wired into `gradeDispatch` in code.** New file
`src/okx/xmtpDeliverable.ts` shells out to the separate `okx-a2a` binary
(`task requests --json` → find the message matching the jobId → `file download` with the
decrypted fileKey/digest/salt/nonce/secret) and is now called automatically as a fallback
inside `gradeDispatch` whenever `task-deliverable-list` comes back empty. This is no longer
a manual step.

**The x402/A2MCP branch of `dispatchCanary` was exercised against live data for real,**
targeting SPOILER's "Board Snapshot" service (0.25 USDT, real payment, confirmed via
balance check before/after) — entirely through the real `dispatchCanary`/`gradeDispatch`
code path, not hand-run CLI commands.

**Running `reconcileAll` for real surfaced and fixed two more genuine bugs** — both only
discoverable by actually running the code against live data, which is exactly why this
round of testing mattered:

1. `agent status <jobId>` always returns pretty console text on the real CLI, never JSON,
   and prints `"Task status: complete"` — no trailing "d". The code's resolution map only
   recognized `"completed"` (derived from the documented status-code table), so a
   genuinely finished task was being silently treated as still pending, forever. Fixed in
   `src/outcome/feedbackLoop.ts`, with a regression test reproducing the exact pretty-text
   shape via the fake CLI.
2. x402-paid jobs never had `client.complete()` called on them (the code assumed payment
   settling atomically via `task-402-pay` meant no further action was needed), so their
   underlying task status stayed stuck at `"accepted"` forever and could never be
   reconciled into the outcome ledger. Before changing this, I asked the user whether to
   test it live, and — with their go-ahead — called `agent complete` on the real, already-
   paid SPOILER job and confirmed via wallet balance before/after (both 1.483242 USDT,
   unchanged) that it's a safe no-op for payment while correctly finalizing task status to
   `"complete"`. `gradeDispatch` now calls `complete()` unconditionally for both payment
   modes.

After both fixes, running the real `reconcileAll` against the real database recorded
`{"recorded": 2, "pending": 0}` — both real dispatches (TaskScout AI's A2A canary and
SPOILER's x402 canary) now correctly appear as `outcome_ledger_entries` rows with
`resolution: "released_clean"`.

**`/score` had never been called against real data before this — and it broke on the
first real call.** Postgres's `extract(epoch from ...)` returns `numeric`, not
`double precision`, but the Rust code's `ScoredPoint`/`OutcomeRow` structs decode `age_days`
as `f64` — a type mismatch that simply never had real rows to surface it until now. Fixed
with an explicit `::float8` cast in both queries in `src/db.rs`. After the fix, `/score`
correctly returned a real, non-fixture score (1.0) for both TaskScout AI and SPOILER, with
`confidence_bucket: "unproven"` in both cases — correctly conservative, since each only has
one real evidence point so far.

**`/consistency/variance` was called for real** against TaskScout AI's one real canary
score — it works and writes a real `consistency_runs` row, but with only one data point the
result (variance 0) is trivial. Genuine multi-point variance still needs the second
TaskScout AI dispatch (still sitting at `created`, unaccepted, as of this writing) to
complete.

**`/v1/web/lookup` was called for real, end to end, and correctly surfaced the real
evidence** it had never had before. A query matching TaskScout AI's actual listed service
returned it as a ranked candidate with `evidence_summary.canary_score_this_category: 1`,
`tasks_completed_this_category: 1`, and `consistency_variance: "low"` — real numbers, not
placeholders, produced by the real discovery → real scoring → real shortlist-assembly
pipeline running against the real production database.