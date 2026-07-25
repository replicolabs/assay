-- Tracks jobIds Assay's ASP identity has already delivered a real
-- deliverable for (`agent deliver`), so the deliverer loop never re-delivers
-- for the same task. Only fires for tasks that have reached on-chain
-- `accepted` status (job_accepted) — escrow funded, negotiation complete —
-- per OKX's documented protocol (okx-ai skill, task-asp.md): "deliver is
-- gated by job_accepted"; delivering earlier is rejected server-side and
-- would mean working before payment is secured even if it weren't.
create table a2a_delivered_tasks (
    job_id                  text primary key,
    okx_agent_id            text not null,
    counterparty_agent_id   text,
    assessment_request_id   text,
    delivered_at            timestamptz not null default now()
);
