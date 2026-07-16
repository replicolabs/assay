import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { OnchainosClient } from "../../src/okx/onchainosClient.js";
import { loadOnchainosConfig } from "../../src/okx/config.js";
import { EngineClient } from "../../src/engine/engineClient.js";
import { dispatchCanary, gradeDispatch, DispatchPreflightError, type CanaryTaskRow } from "../../src/canary/dispatcher.js";
import type { Database } from "../../src/db/schema.js";

const client = new OnchainosClient(loadOnchainosConfig({}));

/** Minimal Kysely stand-in for gradeDispatch's reads/writes, following the recordingDb pattern in test/outcome/feedbackLoop.test.ts. */
function gradingDb() {
  const updated: Record<string, unknown>[] = [];
  const db = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirstOrThrow: async () => ({ agent_id: "agent-row-1" })
        })
      })
    }),
    updateTable: () => ({
      set: (v: Record<string, unknown>) => {
        updated.push(v);
        return { where: () => ({ execute: async () => undefined }) };
      }
    })
  } as unknown as Kysely<Database>;
  return { db, updated };
}

/** Throws on any access — proves a preflight check short-circuits before ever touching the DB. */
const untouchableDb = new Proxy(
  {},
  {
    get() {
      throw new Error("db was touched — a preflight check that should have thrown first didn't");
    }
  }
) as Kysely<Database>;

function canaryTask(overrides: Record<string, unknown> = {}): CanaryTaskRow {
  return {
    id: "canary-task-1",
    skill_category_id: "general",
    grading_mode: "schema",
    prompt_payload: {
      title: "Canary: task difficulty",
      description: "Evaluate this task's difficulty, twenty chars min",
      descriptionSummary: "Difficulty canary",
      budget: "0.02",
      maxBudget: "0.03",
      currency: "USDT",
      serviceId: "1",
      ...overrides
    }
  };
}

describe("dispatchCanary preflight checks (against the fake CLI)", () => {
  it("throws DispatchPreflightError when the canary task has no serviceId, without touching the DB", async () => {
    const task = canaryTask({ serviceId: undefined });
    await expect(dispatchCanary(client, untouchableDb, { agentRowId: "row-1", okxAgentId: "1001" }, task)).rejects.toThrow(DispatchPreflightError);
    await expect(dispatchCanary(client, untouchableDb, { agentRowId: "row-1", okxAgentId: "1001" }, task)).rejects.toThrow(/serviceId/);
  });

  it("throws DispatchPreflightError when the designated provider is offline, without touching the DB", async () => {
    const task = canaryTask({ serviceId: "5" });
    await expect(dispatchCanary(client, untouchableDb, { agentRowId: "row-5", okxAgentId: "1005" }, task)).rejects.toThrow(DispatchPreflightError);
    await expect(dispatchCanary(client, untouchableDb, { agentRowId: "row-5", okxAgentId: "1005" }, task)).rejects.toThrow(/not online/);
  });

  it("throws DispatchPreflightError when the referenced serviceId no longer exists on the agent, without touching the DB", async () => {
    const task = canaryTask({ serviceId: "does-not-exist" });
    await expect(dispatchCanary(client, untouchableDb, { agentRowId: "row-1", okxAgentId: "1001" }, task)).rejects.toThrow(DispatchPreflightError);
    await expect(dispatchCanary(client, untouchableDb, { agentRowId: "row-1", okxAgentId: "1001" }, task)).rejects.toThrow(/not found/);
  });
});

describe("gradeDispatch calls client.complete() for both payment modes", () => {
  // x402's task-402-pay settles payment atomically at dispatch time, but
  // `agent complete` is still required afterward to finalize the on-chain
  // task's STATUS to a terminal state (live-verified safe — no double
  // payment — on a real x402 job; see dispatcher.ts for detail). Without
  // it, x402 dispatches stay stuck at "accepted" forever and reconcileOne
  // can never record an outcome for them. This test locks in that both
  // payment modes now call complete() unconditionally.
  for (const paymentMode of ["x402", "escrow"] as const) {
    it(`calls client.complete(jobId) when paymentMode is "${paymentMode}"`, async () => {
      const engine = new EngineClient();
      vi.spyOn(engine, "gradeCanary").mockResolvedValue({ score: 0.9 });
      const completeSpy = vi.spyOn(client, "complete").mockResolvedValue(undefined);

      const { db } = gradingDb();
      const task = canaryTask();
      const result = await gradeDispatch(client, engine, db, "dispatch-1", "fake-job-1", task, "1001", paymentMode, "buyer-agent-1");

      expect(completeSpy).toHaveBeenCalledTimes(1);
      expect(completeSpy).toHaveBeenCalledWith("fake-job-1");
      expect(result.score).toBe(0.9);

      completeSpy.mockRestore();
    });
  }
});
