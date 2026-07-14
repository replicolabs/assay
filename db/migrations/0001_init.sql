-- Assay core schema.
-- Single source of truth for both the Rust engine (sqlx) and the TS gateway (kysely).
-- gen_random_uuid() is built into Postgres core since v13 (no pgcrypto extension needed).

-- Assay's own skill taxonomy. OKX.AI itself has no fixed category enum (matching is
-- free-text/semantic via `asp-match`), so this table is how Assay organizes canary
-- banks, decay tuning, and category-isolated scoring.
create table skill_categories (
    id                  text primary key,           -- e.g. 'code_generation.smart_contract_audit'
    name                text not null,
    decay_half_life_days double precision not null default 30,
    created_at          timestamptz not null default now()
);

-- Local cache of OKX.AI registry entries observed via `agent search` / `agent get-agents`.
create table agents (
    id                  uuid primary key default gen_random_uuid(),
    okx_agent_id        text not null unique,        -- OKX's agentId
    name                text not null,
    role                text not null check (role in ('user', 'asp', 'evaluator')),
    owner_address       text,
    status              text not null default 'active' check (status in ('active', 'inactive', 'unknown')),
    first_seen_at       timestamptz not null default now(),
    last_synced_at      timestamptz not null default now()
);

-- Local cache of `agent service-list --agent-id N` rows.
create table agent_services (
    id                      uuid primary key default gen_random_uuid(),
    agent_id                uuid not null references agents(id) on delete cascade,
    okx_service_id          text,
    name                    text not null,
    service_type            text not null check (service_type in ('a2a', 'a2mcp')),
    fee_amount              double precision,
    fee_token               text,
    endpoint                text,
    description             text,
    skill_category_id       text references skill_categories(id),
    synced_at               timestamptz not null default now(),
    unique (agent_id, okx_service_id)
);
create index idx_agent_services_category on agent_services(skill_category_id);

-- Canary task bank: known-answer benchmark tasks per skill category.
create table canary_tasks (
    id                  uuid primary key default gen_random_uuid(),
    skill_category_id   text not null references skill_categories(id),
    prompt_payload      jsonb not null,               -- task description + service params, dressed as a real task
    reference_output    jsonb not null,                -- expected answer / grading rubric
    grading_mode        text not null check (grading_mode in ('exact', 'schema', 'numeric', 'rubric')),
    status              text not null default 'active' check (status in ('active', 'rotated_out')),
    last_rotated_at     timestamptz not null default now(),
    created_at          timestamptz not null default now()
);
create index idx_canary_tasks_category on canary_tasks(skill_category_id, status);

-- One instance of a canary task sent to one candidate agent.
create table canary_dispatches (
    id                  uuid primary key default gen_random_uuid(),
    canary_task_id      uuid not null references canary_tasks(id),
    agent_id            uuid not null references agents(id),
    okx_job_id          text unique,                  -- set once published on-chain (create-task / draft publish)
    status              text not null default 'pending'
                         check (status in ('pending', 'published', 'delivered', 'graded', 'timed_out', 'failed')),
    dispatched_at       timestamptz not null default now(),
    delivered_at        timestamptz,
    graded_at           timestamptz
);
create index idx_canary_dispatches_agent on canary_dispatches(agent_id, status);

create table canary_results (
    id                  uuid primary key default gen_random_uuid(),
    dispatch_id         uuid not null references canary_dispatches(id) on delete cascade,
    agent_id            uuid not null references agents(id),
    skill_category_id   text not null references skill_categories(id),
    score               double precision not null check (score >= 0 and score <= 1),
    grading_detail       jsonb not null default '{}'::jsonb,
    created_at          timestamptz not null default now()
);
create index idx_canary_results_agent_category on canary_results(agent_id, skill_category_id, created_at desc);

-- Outcome Ledger. Two sourcing paths, distinguished by `source`:
--   'routed'           - Assay itself published the task (canary or a hire it brokered)
--                         and observed it to terminal state via `agent status <jobId>` polling.
--   'organic_feedback' - derived from public `agent feedback-list --agent-id N` review rows,
--                         since raw task/escrow event streams are peer-permissioned (XMTP),
--                         not publicly subscribable for arbitrary third-party tasks.
create table outcome_ledger_entries (
    id                          uuid primary key default gen_random_uuid(),
    agent_id                    uuid not null references agents(id),
    skill_category_id           text references skill_categories(id),
    okx_job_id                  text,
    source                      text not null check (source in ('routed', 'organic_feedback')),
    requester_wallet_address    text,
    resolution                  text not null
                                 check (resolution in ('released_clean', 'disputed_for_agent', 'disputed_against_agent', 'abandoned')),
    escrow_amount               double precision,
    escrow_token                text,
    review_score                double precision check (review_score >= 0 and review_score <= 5),
    occurred_at                 timestamptz not null,
    created_at                  timestamptz not null default now(),
    unique (okx_job_id, agent_id)
);
create index idx_outcome_ledger_agent_category on outcome_ledger_entries(agent_id, skill_category_id, occurred_at desc);

-- Wallet-clustering support for sybil resistance. Append-only heuristic hits;
-- a wallet can appear under multiple cluster_keys from different heuristics.
create table sybil_wallet_clusters (
    id              uuid primary key default gen_random_uuid(),
    cluster_key     text not null,
    wallet_address  text not null,
    heuristic       text not null,                    -- e.g. 'shared_funding_source', 'first_interaction_cohort'
    detected_at     timestamptz not null default now(),
    unique (wallet_address, cluster_key, heuristic)
);
create index idx_sybil_cluster_key on sybil_wallet_clusters(cluster_key);

-- For any candidate under active deep-assessment consideration: N task-variant
-- dispatches and the resulting score spread.
create table consistency_runs (
    id                  uuid primary key default gen_random_uuid(),
    agent_id            uuid not null references agents(id),
    skill_category_id   text not null references skill_categories(id),
    dispatch_ids        jsonb not null,                -- array of canary_dispatches.id
    mean_score          double precision,
    variance            double precision,
    stdev               double precision,
    created_at          timestamptz not null default now()
);
create index idx_consistency_runs_agent_category on consistency_runs(agent_id, skill_category_id, created_at desc);

-- Append-only composite score history (recency-weighted recompute writes a new row,
-- never overwrites) -- this is what makes drift/divergence detection possible:
-- compare the latest row against one from N days back.
create table composite_scores (
    id                          uuid primary key default gen_random_uuid(),
    agent_id                    uuid not null references agents(id),
    skill_category_id           text not null references skill_categories(id),
    score                       double precision not null check (score >= 0 and score <= 1),
    confidence_bucket           text not null
                                 check (confidence_bucket in ('unproven', 'emerging', 'proven', 'high_confidence')),
    evidence_count              integer not null default 0,
    canary_component            double precision,
    outcome_component           double precision,
    consistency_penalty         double precision,
    divergence_flag             boolean not null default false,
    recent_vs_historical_delta  double precision,
    computed_at                 timestamptz not null default now()
);
create index idx_composite_scores_latest on composite_scores(agent_id, skill_category_id, computed_at desc);

-- One row per Assay response (A2MCP fast lookup or A2A deep assessment).
create table assessments (
    id                      uuid primary key default gen_random_uuid(),
    channel                 text not null check (channel in ('a2mcp', 'a2a')),
    task_summary            text not null,
    skill_category_id       text references skill_categories(id),
    acceptance_criteria     jsonb,
    requester_identifier    text,
    ranked_candidates       jsonb not null,             -- snapshot: [{agent_id, fit_reasoning, evidence_summary, confidence_bucket, recommended_terms}]
    fee_status               text not null default 'not_applicable'
                              check (fee_status in ('pending', 'released', 'not_applicable')),
    routed_job_id            text,                       -- set once the requester hires a candidate, for outcome feedback tracking
    created_at               timestamptz not null default now(),
    resolved_at              timestamptz
);
create index idx_assessments_routed_job on assessments(routed_job_id) where routed_job_id is not null;
