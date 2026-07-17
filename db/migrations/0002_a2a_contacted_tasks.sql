-- Tracks jobIds Assay's ASP identity has already sent the A2A cold-start
-- opener to (`agent contact-user`), so the responder loop never re-sends it
-- for the same task. Deliberately does NOT track `apply` — OKX's own
-- documented protocol (okx-ai skill, task-asp-accept.md) states `apply` is
-- system-event-triggered only ("JobAspSelected" playbook) and must never be
-- invoked manually/automatically from the cold-start path, since doing so
-- risks state-machine corruption or working the escrow-funding step out of
-- order.
create table a2a_contacted_tasks (
    job_id                  text primary key,
    okx_agent_id            text not null,
    counterparty_agent_id   text,
    contacted_at            timestamptz not null default now()
);
