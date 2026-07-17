import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { OnchainosClient } from "../../src/okx/onchainosClient.js";
import { loadOnchainosConfig } from "../../src/okx/config.js";
import { respondToNewAspTasks } from "../../src/okx/a2aResponder.js";
import type { Database } from "../../src/db/schema.js";

const client = new OnchainosClient(loadOnchainosConfig({}));

/** Fake CLI (test/fakes/onchainos) always returns one active-tasks row: jobId 0xsandboxtask1, myAgentId 1001, status created. */
function fakeContactDb(preContacted: string[] = []) {
  const contacted = new Set(preContacted);
  const inserted: Record<string, unknown>[] = [];
  const db = {
    selectFrom: () => ({
      select: () => ({
        where: (_col: string, _op: string, val: string) => ({
          executeTakeFirst: async () => (contacted.has(val) ? { job_id: val } : undefined)
        })
      })
    }),
    insertInto: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        contacted.add(v.job_id as string);
        return { onConflict: () => ({ execute: async () => undefined }) };
      }
    })
  } as unknown as Kysely<Database>;
  return { db, inserted, contacted };
}

describe("respondToNewAspTasks against the fake CLI", () => {
  it("sends the cold-start opener to a new task designating our ASP identity, and records it", async () => {
    const { db, inserted } = fakeContactDb();
    const result = await respondToNewAspTasks(client, db, "1001");
    expect(result.contacted).toEqual(["0xsandboxtask1"]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ job_id: "0xsandboxtask1", okx_agent_id: "1001", counterparty_agent_id: "9001" });
  });

  it("does not re-contact a task already recorded as contacted", async () => {
    const { db, inserted } = fakeContactDb(["0xsandboxtask1"]);
    const result = await respondToNewAspTasks(client, db, "1001");
    expect(result.contacted).toEqual([]);
    expect(inserted).toHaveLength(0);
  });

  it("ignores tasks that don't designate this ASP identity", async () => {
    const { db, inserted } = fakeContactDb();
    const result = await respondToNewAspTasks(client, db, "9999");
    expect(result.contacted).toEqual([]);
    expect(inserted).toHaveLength(0);
  });
});
