-- Tracks jobIds Assay's ASP identity has declined via `agent asp-reject`
-- (boundary testing: politely decline out-of-scope requests) so the
-- responder loop never re-evaluates or re-declines the same task twice.
create table a2a_declined_tasks (
    job_id                  text primary key,
    okx_agent_id            text not null,
    counterparty_agent_id   text,
    reason                  text,
    declined_at             timestamptz not null default now()
);
