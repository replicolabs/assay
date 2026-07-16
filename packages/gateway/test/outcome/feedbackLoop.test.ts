import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { OnchainosClient } from "../../src/okx/onchainosClient.js";
import { loadOnchainosConfig } from "../../src/okx/config.js";
import { reconcileOne, type PendingRoutedJob } from "../../src/outcome/feedbackLoop.js";
import type { Database } from "../../src/db/schema.js";

const client = new OnchainosClient(loadOnchainosConfig({}));

/** Minimal Kysely stand-in that just records what reconcileOne tries to write, without a real Postgres. */
function recordingDb() {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const db = {
    insertInto: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { onConflict: () => ({ execute: async () => undefined }) };
      }
    }),
    updateTable: () => ({
      set: (v: Record<string, unknown>) => {
        updated.push(v);
        return { where: () => ({ execute: async () => undefined }) };
      }
    })
  } as unknown as Kysely<Database>;
  return { db, inserted, updated };
}

function job(overrides: Partial<PendingRoutedJob> = {}): PendingRoutedJob {
  return { jobId: "fake-job", agentRowId: "agent-row-1", okxAgentId: "1001", skillCategoryId: "general", requesterWallet: null, ...overrides };
}

describe("reconcileOne against the fake CLI", () => {
  it("records a JSON-shaped 'completed' status as released_clean", async () => {
    const { db, inserted } = recordingDb();
    const outcome = await reconcileOne(client, db, job());
    expect(outcome).toBe("recorded");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.resolution).toBe("released_clean");
  });

  it("records the pretty-text 'complete' (no trailing d) status as released_clean, not abandoned", async () => {
    // Live-verified: `agent status` always returns pretty console text for this
    // command, never JSON, and prints "Task status: complete". Before the fix,
    // this string didn't match RESOLUTION_BY_STATUS's "completed" key, so
    // isTerminal was false and the job was left "pending" forever.
    const { db, inserted } = recordingDb();
    const outcome = await reconcileOne(client, db, job({ jobId: "0xdeadbeefcafe" }));
    expect(outcome).toBe("recorded");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.resolution).toBe("released_clean");
  });
});
