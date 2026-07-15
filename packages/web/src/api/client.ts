import type { Assessment, LookupRequest } from "../../../gateway/src/api/contracts";
import { pickFixtureFor } from "./fixtures";

/**
 * Single call site for fetching an Assessment. Every other module in the app
 * (App.tsx, ShortlistView, CandidateCard, ...) only ever sees a resolved
 * Assessment — they have no idea whether it came from the live gateway or a
 * local fixture. That knowledge lives entirely here.
 *
 * Fixture fallback, two ways to opt in (see README.md):
 *   1. Explicit:  VITE_USE_FIXTURES=true  (build-time env var), or a
 *      `?mock=1` query param on the page URL (handy for sharing a demo link
 *      without rebuilding).
 *   2. Automatic: if neither flag is set, we still try the real endpoint
 *      first and silently fall back to a fixture if it fails (network error,
 *      404, non-2xx, bad JSON) — the gateway's /v1/web/lookup route isn't
 *      wired up yet in this milestone, so this is what lets the UI run today
 *      and start working for real with zero code changes once it exists.
 */

function fixturesForcedOn(): boolean {
  if (import.meta.env.VITE_USE_FIXTURES === "true") return true;
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mock") === "1") return true;
  }
  return false;
}

/**
 * Frontend and gateway are deployed on separate domains (Vercel + Railway) —
 * a bare relative path only works when they share an origin. Empty string
 * (the local-dev default when unset) keeps relative-path behavior for a dev
 * proxy setup; production (Vercel) sets this to the Railway gateway URL.
 */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

async function fetchFromGateway(request: LookupRequest): Promise<Assessment> {
  const res = await fetch(`${API_BASE_URL}/v1/web/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });

  if (!res.ok) {
    throw new Error(`Gateway responded with ${res.status}`);
  }

  return (await res.json()) as Assessment;
}

export async function fetchAssessment(request: LookupRequest): Promise<Assessment> {
  if (fixturesForcedOn()) {
    return pickFixtureFor(request.task_summary);
  }

  try {
    return await fetchFromGateway(request);
  } catch {
    // Backend not wired up yet (or unreachable) — fall back so the UI stays
    // demoable. Once /v1/web/lookup is live this branch simply stops firing.
    return pickFixtureFor(request.task_summary);
  }
}
