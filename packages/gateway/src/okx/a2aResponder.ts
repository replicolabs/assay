import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { LLMClient } from "../intake/llmClient.js";
import { gateTaskScope } from "../intake/scopeGate.js";
import type { OnchainosClient } from "./onchainosClient.js";

/**
 * Auto-sends the fixed A2A cold-start opener (`agent contact-user`) to any
 * new task that designates Assay's ASP identity, so a counterparty (or an
 * OKX platform test) never sits waiting on a manual response — UNLESS the
 * request is out of scope for what Assay actually does (recommend/rank
 * agents, never perform the underlying task itself), in which case it
 * declines via `asp-reject` instead of engaging in a negotiation it was
 * never going to be able to fulfill. This is OKX's own documented "boundary
 * testing" expectation (how-to-become-a2a: "Verify whether the Agent can
 * politely decline or redirect tasks beyond its capabilities").
 *
 * Root-caused this session: OKX's rejection reason #1 ("unable to receive a
 * response from your Agent, causing the task to time out") turned out not to
 * be about online-status visibility (see heartbeatLoop.ts) but about this —
 * live-verified via `agent active-tasks --role asp --include-terminal`, three
 * real tasks from OKX's own SandboxAgent QA bot sat at status `created` with
 * no opener ever sent, because no code anywhere listened for or responded to
 * inbound negotiation attempts.
 *
 * Deliberately narrow beyond the scope gate: this never calls `apply`. OKX's
 * own documented protocol (okx-ai skill, task-asp-accept.md) is explicit
 * that `apply` is system-event-triggered only (the `JobAspSelected`
 * playbook) and manual/automated invocation from the cold-start path is a
 * documented anti-pattern risking state-machine corruption or escrow issues.
 * Real multi-round negotiation (reading a reply, discussing price, handling
 * scope changes) happens via the okx-a2a daemon's autonomous Claude session,
 * not here — see vendor/claude-config/CLAUDE.md for that policy.
 */
const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;

export async function respondToNewAspTasks(
  client: OnchainosClient,
  db: Kysely<Database>,
  aspAgentId: string,
  llm: LLMClient
): Promise<{ contacted: string[]; declined: string[] }> {
  const { tasks } = await client.activeTasks({ role: "asp" });
  const contacted: string[] = [];
  const declined: string[] = [];

  const candidates = tasks.filter((t) => t.myAgentId === aspAgentId && t.status === "created");
  if (candidates.length === 0) return { contacted, declined };

  // One extra call per tick, not per task — `active-tasks` omits the real
  // description (see ProviderTaskSchema comment in types.ts), so this is
  // the only source for the scope gate to actually read.
  const { providerTasks } = await client.taskInProgress([aspAgentId]).catch(() => ({ providerTasks: [] }));
  const descriptionByJobId = new Map(providerTasks.map((t) => [t.jobId, t.description]));

  for (const task of candidates) {
    const alreadyContacted = await db.selectFrom("a2a_contacted_tasks").select("job_id").where("job_id", "=", task.jobId).executeTakeFirst();
    if (alreadyContacted) continue;
    const alreadyDeclined = await db.selectFrom("a2a_declined_tasks").select("job_id").where("job_id", "=", task.jobId).executeTakeFirst();
    if (alreadyDeclined) continue;

    const description = descriptionByJobId.get(task.jobId);
    if (description) {
      const scope = await gateTaskScope(llm, description);
      if (!scope.inScope) {
        await client.aspReject(task.jobId, aspAgentId, scope.reason);
        await db
          .insertInto("a2a_declined_tasks")
          .values({ job_id: task.jobId, okx_agent_id: aspAgentId, counterparty_agent_id: task.counterpartyAgentId ?? null, reason: scope.reason })
          .onConflict((oc) => oc.column("job_id").doNothing())
          .execute();
        declined.push(task.jobId);
        continue;
      }
    }

    await client.contactUser(task.jobId, aspAgentId);
    await db
      .insertInto("a2a_contacted_tasks")
      .values({ job_id: task.jobId, okx_agent_id: aspAgentId, counterparty_agent_id: task.counterpartyAgentId ?? null })
      .onConflict((oc) => oc.column("job_id").doNothing())
      .execute();
    contacted.push(task.jobId);
  }

  return { contacted, declined };
}

export function startA2AResponderLoop(
  client: OnchainosClient,
  db: Kysely<Database>,
  aspAgentId: string,
  llm: LLMClient,
  intervalMs = DEFAULT_INTERVAL_MS
): () => void {
  const tick = () => {
    respondToNewAspTasks(client, db, aspAgentId, llm).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[a2a-responder] failed:", err);
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
