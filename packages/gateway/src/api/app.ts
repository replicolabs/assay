import Fastify, { type FastifyInstance } from "fastify";
import { registerLookupRoutes } from "./lookup.js";
import { registerAssessRoutes } from "./assess.js";
import type { AppDeps } from "./deps.js";

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({ ok: true }));

  registerLookupRoutes(app, deps);
  registerAssessRoutes(app, deps);

  return app;
}
