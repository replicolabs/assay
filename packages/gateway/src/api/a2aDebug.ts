import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

const execFileAsync = promisify(execFile);

/**
 * TEMPORARY diagnostic route — read-only introspection into the okx-a2a
 * daemon's own local session/dispatch state for a specific job, which
 * otherwise isn't visible from outside the running container (Railway gives
 * deploy logs, not a shell). Added 2026-07-24 to find out whether the
 * daemon's documented "background task processing runs the local Claude CLI"
 * autonomous-negotiation behavior is actually firing on our real pending A2A
 * tasks, or whether our own contactUser-only responder is the only thing
 * happening. Delete this route once that question is answered.
 *
 * Gated on ADMIN_DEBUG_TOKEN (a query param, not a real auth scheme) purely
 * so this isn't a fully open endpoint on a public domain — it only ever
 * shells out to read-only `okx-a2a` inspection subcommands, never anything
 * state-changing, so the blast radius of a leaked token is low, but there's
 * no reason to leave it unguarded.
 */
export function registerA2ADebugRoutes(app: FastifyInstance): void {
  app.get("/internal/a2a-debug", async (request, reply) => {
    const token = process.env.ADMIN_DEBUG_TOKEN;
    const query = request.query as { token?: string; jobId?: string; toAgentId?: string };
    if (!token || query.token !== token) {
      return reply.status(404).send();
    }
    if (!query.jobId) {
      return reply.status(400).send({ error: "jobId query param required" });
    }

    const results: Record<string, unknown> = {};

    async function run(label: string, args: string[]) {
      try {
        const { stdout, stderr } = await execFileAsync("okx-a2a", args, { timeout: 20_000 });
        results[label] = { ok: true, stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000) };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        results[label] = { ok: false, stdout: e.stdout?.slice(0, 4000), stderr: e.stderr?.slice(0, 4000), error: e.message };
      }
    }

    await run("daemon_status", ["daemon", "status"]);
    await run("session_status", ["session", "status"]);
    if (query.toAgentId) {
      await run("session_history", ["session", "history", "--job-id", query.jobId, "--toAgentId", query.toAgentId, "--json", "--limit", "20"]);
    }
    await run("session_query", ["session", "query", "--job-id", query.jobId, "--json"]);
    await run("user_list", ["user", "list", "--json"]);

    return reply.send(results);
  });
}
