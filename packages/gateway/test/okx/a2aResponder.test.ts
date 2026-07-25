import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { OnchainosClient } from "../../src/okx/onchainosClient.js";
import { loadOnchainosConfig } from "../../src/okx/config.js";
import { respondToNewAspTasks } from "../../src/okx/a2aResponder.js";
import type { Database } from "../../src/db/schema.js";
import type { LLMClient } from "../../src/intake/llmClient.js";

const client = new OnchainosClient(loadOnchainosConfig({}));

function fakeLlm(inScope: boolean): LLMClient {
  return { complete: async () => JSON.stringify({ in_scope: inScope, reason: inScope ? "matches Assay's service" : "asks Assay to do the work itself" }) };
}

/**
 * Fake CLI (test/fakes/onchainos) always returns one active-tasks row
 * (jobId 0xsandboxtask1, myAgentId 1001, status created) and a matching
 * task-in-progress row with a real description, so the scope gate has
 * something to evaluate. Tracks contacted/declined per table, matching real
 * Kysely usage (`db.selectFrom("a2a_contacted_tasks")` vs `"...declined..."`).
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
  it("sends the cold-start opener to an in-scope task designating our ASP identity, and records it", async () => {
    const { db, insertedContacted, insertedDeclined } = fakeResponderDb();
    const result = await respondToNewAspTasks(client, db, "1001", fakeLlm(true));
    expect(result.contacted).toEqual(["0xsandboxtask1"]);
    expect(result.declined).toEqual([]);
    expect(insertedContacted).toHaveLength(1);
    expect(insertedContacted[0]).toMatchObject({ job_id: "0xsandboxtask1", okx_agent_id: "1001", counterparty_agent_id: "9001" });
    expect(insertedDeclined).toHaveLength(0);
  });

  it("declines an out-of-scope task instead of contacting, and records it", async () => {
    const { db, insertedContacted, insertedDeclined } = fakeResponderDb();
    const result = await respondToNewAspTasks(client, db, "1001", fakeLlm(false));
    expect(result.contacted).toEqual([]);
    expect(result.declined).toEqual(["0xsandboxtask1"]);
    expect(insertedContacted).toHaveLength(0);
    expect(insertedDeclined).toHaveLength(1);
    expect(insertedDeclined[0]).toMatchObject({ job_id: "0xsandboxtask1", okx_agent_id: "1001", reason: "asks Assay to do the work itself" });
  });

  it("does not re-contact a task already recorded as contacted", async () => {
    const { db, insertedContacted } = fakeResponderDb({ preContacted: ["0xsandboxtask1"] });
    const result = await respondToNewAspTasks(client, db, "1001", fakeLlm(true));
    expect(result.contacted).toEqual([]);
    expect(insertedContacted).toHaveLength(0);
  });

  it("does not re-evaluate a task already recorded as declined", async () => {
    const { db, insertedDeclined } = fakeResponderDb({ preDeclined: ["0xsandboxtask1"] });
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
