import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerLookupRoutes } from "./lookup.js";
import { registerAssessRoutes } from "./assess.js";
import type { AppDeps } from "./deps.js";

/**
 * Comma-separated allowlist (CORS_ORIGIN env var) — the web frontend and the
 * gateway are deployed on different domains (Vercel + Railway), so without
 * this every browser fetch from the frontend fails as a cross-origin request.
 * Non-browser callers (agents, curl) aren't subject to CORS at all, so this
 * only gates the human web UI's access, not the A2MCP/A2A surface itself.
 */
function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw) return ["http://localhost:5173"];
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: corsOrigins() });

  app.get("/healthz", async () => ({ ok: true }));

  registerLookupRoutes(app, deps);
  registerAssessRoutes(app, deps);

  return app;
}
