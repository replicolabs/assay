import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/schema.js";
import { OnchainosClient } from "../../src/okx/onchainosClient.js";
import { loadOnchainosConfig } from "../../src/okx/config.js";
import { NullLLMClient } from "../../src/intake/llmClient.js";
import type { EngineClient } from "../../src/engine/engineClient.js";

// deliverAcceptedAspTasks orchestrates the real evaluation pipeline
// (buildShortlist/persistAssessment) but this test is about the orchestration
// logic — which tasks get delivered, skip-if-already-delivered, the DB record
// written — not the pipeline's own scoring math (untested here, has no unit
// tests of its own to duplicate). Same pattern as test/api/lookup.test.ts.
vi.mock("../../src/api/assessmentService.js", () => ({
  buildShortlist: vi.fn(async () => [
    {
      agent_id: "1001",
      agent_name: "SolWatch Auditor",
      fit_reasoning: "matches",
      evidence_summary: {
        canary_score_this_category: 0.8,
        tasks_completed_this_category: 3,
        disputes_against: 0,
        consistency_variance: "low",
        divergence_flag: false,
        recent_vs_historical_delta: null
      },
      confidence_bucket: "proven",
      score: 0.8,
      recommended_terms: { escrow_split: "50/50", milestone_structure: "single_delivery", holdback_pct: 0.5, require_stricter_acceptance_criteria: false }
    }
  ]),
  persistAssessment: vi.fn(async () => "req-abc")
}));

const { deliverAcceptedAspTasks } = await import("../../src/okx/a2aDeliverer.js");
const { buildShortlist, persistAssessment } = await import("../../src/api/assessmentService.js");

const client = new OnchainosClient(loadOnchainosConfig({}));
const llm = new NullLLMClient();
const engine = {} as EngineClient;

/** Fake CLI (test/fakes/onchainos) always returns one providerTasks row: jobId 0xacceptedtask1, providerAgentId 1001, status 1 (accepted). */
function fakeDeliveredDb(preDelivered: string[] = []) {
  const delivered = new Set(preDelivered);
  const inserted: Record<string, unknown>[] = [];
  const db = {
    selectFrom: () => ({
      select: () => ({
        where: (_col: string, _op: string, val: string) => ({
          executeTakeFirst: async () => (delivered.has(val) ? { job_id: val } : undefined)
        })
      })
    }),
    insertInto: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        delivered.add(v.job_id as string);
        return { onConflict: () => ({ execute: async () => undefined }) };
      }
    })
  } as unknown as Kysely<Database>;
  return { db, inserted };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("deliverAcceptedAspTasks against the fake CLI", () => {
  it("delivers a real assessment for a newly-accepted task designating our ASP identity, and records it", async () => {
    const { db, inserted } = fakeDeliveredDb();
    const result = await deliverAcceptedAspTasks(client, { db, engine, llm }, "1001");

    expect(result.delivered).toEqual(["0xacceptedtask1"]);
    expect(buildShortlist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskSummary: "Evaluate top 3 vendors for consistency and recommend an escrow split with milestones." })
    );
    expect(persistAssessment).toHaveBeenCalledWith(db, expect.objectContaining({ channel: "a2a", feeStatus: "pending" }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ job_id: "0xacceptedtask1", okx_agent_id: "1001", counterparty_agent_id: "9001", assessment_request_id: "req-abc" });
  });

  it("does not re-deliver a task already recorded as delivered", async () => {
    const { db, inserted } = fakeDeliveredDb(["0xacceptedtask1"]);
    const result = await deliverAcceptedAspTasks(client, { db, engine, llm }, "1001");

    expect(result.delivered).toEqual([]);
    expect(inserted).toHaveLength(0);
    expect(buildShortlist).not.toHaveBeenCalled();
  });

  it("never calls deliver for an x402-mode task, even if it shows status accepted", async () => {
    const { db, inserted } = fakeDeliveredDb();
    const result = await deliverAcceptedAspTasks(client, { db, engine, llm }, "1001");

    expect(result.delivered).not.toContain("0xacceptedx402task");
    expect(inserted.map((i) => i.job_id)).not.toContain("0xacceptedx402task");
    expect(buildShortlist).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ taskSummary: "Should never reach agent deliver." }));
  });

  it("ignores tasks that don't designate this ASP identity", async () => {
    const { db, inserted } = fakeDeliveredDb();
    const result = await deliverAcceptedAspTasks(client, { db, engine, llm }, "9999");

    expect(result.delivered).toEqual([]);
    expect(inserted).toHaveLength(0);
  });
});
