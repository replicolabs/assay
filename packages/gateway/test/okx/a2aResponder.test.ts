import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { OnchainosClient } from "../../src/okx/onchainosClient.js";
import { loadOnchainosConfig } from "../../src/okx/config.js";
import { respondToNewAspTasks } from "../../src/okx/a2aResponder.js";
import type { Database } from "../../src/db/schema.js";
import type { LLMClient } from "../../src/intake/llmClient.js";

const client = new OnchainosClient(loadOnchainosConfig({}));

/** Classifies every candidate the same way, regardless of its real description. */
function fakeLlm(inScope: boolean): LLMClient {
  return { complete: async () => JSON.stringify({ in_scope: inScope, reason: inScope ? "matches Assay's service" : "asks Assay to do the work itself" }) };
}

/**
 * Fake CLI (test/fakes/onchainos) returns two active-tasks rows designating
 * our fake ASP (1001), both status "created", with matching task-in-progress
 * descriptions: 0xsandboxtask1 ("find and rank agents...") and 0xracedjob
 * ("write my smart contract..." — also the magic jobId that makes the fake
 * `asp-reject` reproduce the real race condition against an already-applied
 * job). Tracks contacted/declined per table, matching real Kysely usage.
 */
function fakeResponderDb(opts: { preContacted?: string[]; preDeclined?: string[] } = {}) {
  const contacted = new Set(opts.preContacted ?? []);
  const declined = new Set(opts.preDeclined ?? []);
  const insertedContacted: Record<string, unknown>[] = [];
  const insertedDeclined: Record<string, unknown>[] = [];

  const db = {
    selectFrom: (table: string) => ({
      select: () => ({
        where: (_col: string, _op: string, val: string) => ({
          executeTakeFirst: async () => {
            const set = table === "a2a_declined_tasks" ? declined : contacted;
            return set.has(val) ? { job_id: val } : undefined;
          }
        })
      })
    }),
    insertInto: (table: string) => ({
      values: (v: Record<string, unknown>) => {
        if (table === "a2a_declined_tasks") {
          insertedDeclined.push(v);
          declined.add(v.job_id as string);
        } else {
          insertedContacted.push(v);
          contacted.add(v.job_id as string);
        }
        return { onConflict: () => ({ execute: async () => undefined }) };
      }
    })
  } as unknown as Kysely<Database>;

  return { db, insertedContacted, insertedDeclined };
}

describe("respondToNewAspTasks against the fake CLI", () => {
  it("sends the cold-start opener to in-scope tasks designating our ASP identity, and records them", async () => {
    const { db, insertedContacted, insertedDeclined } = fakeResponderDb();
    const result = await respondToNewAspTasks(client, db, "1001", fakeLlm(true));
    expect(result.contacted.sort()).toEqual(["0xracedjob", "0xsandboxtask1"]);
    expect(result.declined).toEqual([]);
    expect(insertedContacted).toHaveLength(2);
    expect(insertedContacted.find((c) => c.job_id === "0xsandboxtask1")).toMatchObject({ okx_agent_id: "1001", counterparty_agent_id: "9001" });
    expect(insertedDeclined).toHaveLength(0);
  });

  it("declines out-of-scope tasks instead of contacting, and records them", async () => {
    const { db, insertedContacted, insertedDeclined } = fakeResponderDb();
    const result = await respondToNewAspTasks(client, db, "1001", fakeLlm(false));
    expect(result.declined).toEqual(["0xsandboxtask1"]);
    expect(insertedDeclined).toHaveLength(1);
    expect(insertedDeclined[0]).toMatchObject({ job_id: "0xsandboxtask1", okx_agent_id: "1001", reason: "asks Assay to do the work itself" });
    // 0xracedjob is also scored out-of-scope but the fake CLI reproduces the
    // real "apply record already exists" race — see the dedicated test below
    // for the exact assertion on that path.
    expect(insertedContacted.map((c) => c.job_id)).toContain("0xracedjob");
  });

  it("treats an asp-reject 'apply record already exists' race as already-handled, not a failure to retry", async () => {
    // Real scenario (live-verified 2026-07-25): the daemon's autonomous
    // session already applied to this job via the legitimate event-triggered
    // path before this polling tick ran its own (independent) scope gate.
    // The platform correctly refuses the resulting contradictory decline —
    // that should be recorded as handled, not retried every tick forever.
    const { db, insertedContacted, insertedDeclined } = fakeResponderDb();
    const result = await respondToNewAspTasks(client, db, "1001", fakeLlm(false));

    expect(result.declined).not.toContain("0xracedjob");
    expect(insertedDeclined.map((d) => d.job_id)).not.toContain("0xracedjob");
    const recorded = insertedContacted.find((c) => c.job_id === "0xracedjob");
    expect(recorded).toMatchObject({ okx_agent_id: "1001", counterparty_agent_id: "9002" });
  });

  it("does not re-contact a task already recorded as contacted", async () => {
    const { db, insertedContacted } = fakeResponderDb({ preContacted: ["0xsandboxtask1", "0xracedjob"] });
    const result = await respondToNewAspTasks(client, db, "1001", fakeLlm(true));
    expect(result.contacted).toEqual([]);
    expect(insertedContacted).toHaveLength(0);
  });

  it("does not re-evaluate a task already recorded as declined", async () => {
    const { db, insertedDeclined } = fakeResponderDb({ preDeclined: ["0xsandboxtask1", "0xracedjob"] });
    const result = await respondToNewAspTasks(client, db, "1001", fakeLlm(false));
    expect(result.declined).toEqual([]);
    expect(insertedDeclined).toHaveLength(0);
  });

  it("ignores tasks that don't designate this ASP identity", async () => {
    const { db, insertedContacted } = fakeResponderDb();
    const result = await respondToNewAspTasks(client, db, "9999", fakeLlm(true));
    expect(result.contacted).toEqual([]);
    expect(insertedContacted).toHaveLength(0);
  });
});
