import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { OnchainosClient } from "./onchainosClient.js";

/**
 * Auto-sends the fixed A2A cold-start opener (`agent contact-user`) to any
 * new task that designates Assay's ASP identity, so a counterparty (or an
 * OKX platform test) never sits waiting on a manual response.
 *
 * Root-caused this session: OKX's rejection reason #1 ("unable to receive a
 * response from your Agent, causing the task to time out") turned out not to
 * be about online-status visibility (see heartbeatLoop.ts) but about this —
 * live-verified via `agent active-tasks --role asp --include-terminal`, three
 * real tasks from OKX's own SandboxAgent QA bot sat at status `created` with
 * no opener ever sent, because no code anywhere listened for or responded to
 * inbound negotiation attempts.
 *
 * Deliberately narrow scope: this sends ONLY the fixed opener, never `apply`.
 * OKX's own documented protocol (okx-ai skill, task-asp-accept.md) is
 * explicit that `apply` is system-event-triggered only (the `JobAspSelected`
 * playbook) and manual/automated invocation from the cold-start path is a
 * documented anti-pattern risking state-machine corruption or escrow issues.
 * Real multi-round negotiation (reading a reply, discussing price) would
 * need an LLM in the loop — that's future work, not this responder.
 */
const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;

export async function respondToNewAspTasks(client: OnchainosClient, db: Kysely<Database>, aspAgentId: string): Promise<{ contacted: string[] }> {
  const { tasks } = await client.activeTasks({ role: "asp" });
  const contacted: string[] = [];

  for (const task of tasks) {
    if (task.myAgentId !== aspAgentId || task.status !== "created") continue;

    const already = await db.selectFrom("a2a_contacted_tasks").select("job_id").where("job_id", "=", task.jobId).executeTakeFirst();
    if (already) continue;

    await client.contactUser(task.jobId, aspAgentId);
    await db
      .insertInto("a2a_contacted_tasks")
      .values({ job_id: task.jobId, okx_agent_id: aspAgentId, counterparty_agent_id: task.counterpartyAgentId ?? null })
      .onConflict((oc) => oc.column("job_id").doNothing())
      .execute();
    contacted.push(task.jobId);
  }

  return { contacted };
}

export function startA2AResponderLoop(client: OnchainosClient, db: Kysely<Database>, aspAgentId: string, intervalMs = DEFAULT_INTERVAL_MS): () => void {
  const tick = () => {
    respondToNewAspTasks(client, db, aspAgentId).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[a2a-responder] failed:", err);
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
