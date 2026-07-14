import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";

/**
 * Canary task bank: known-answer benchmarks per skill category (spec §5.1).
 * Rotation prevents agents from building a stable "known test" memory across
 * a static set — `rotateStale` marks old tasks `rotated_out`; replenishing
 * the bank with fresh content is a content-authoring step (LLM-assisted),
 * intentionally kept out of this module so the storage/rotation mechanics
 * stay independent of how canary content gets written.
 */

export interface NewCanaryTask {
  skillCategoryId: string;
  promptPayload: unknown;
  referenceOutput: unknown;
  gradingMode: "exact" | "schema" | "numeric" | "rubric";
}

export async function createCanaryTask(db: Kysely<Database>, task: NewCanaryTask): Promise<string> {
  const row = await db
    .insertInto("canary_tasks")
    .values({
      skill_category_id: task.skillCategoryId,
      prompt_payload: JSON.stringify(task.promptPayload),
      reference_output: JSON.stringify(task.referenceOutput),
      grading_mode: task.gradingMode,
      status: "active"
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function listActiveCanaryTasks(db: Kysely<Database>, skillCategoryId: string) {
  return db.selectFrom("canary_tasks").selectAll().where("skill_category_id", "=", skillCategoryId).where("status", "=", "active").execute();
}

/** Marks canary tasks older than `maxAgeDays` (by last_rotated_at) as rotated_out. Returns the count rotated. */
export async function rotateStale(db: Kysely<Database>, skillCategoryId: string, maxAgeDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  const result = await db
    .updateTable("canary_tasks")
    .set({ status: "rotated_out" })
    .where("skill_category_id", "=", skillCategoryId)
    .where("status", "=", "active")
    .where("last_rotated_at", "<", cutoff)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

/** Simple round-robin pick from the active bank so repeated dispatches to the
 * same agent over time don't always draw the same canary. */
export async function pickCanaryTask(db: Kysely<Database>, skillCategoryId: string) {
  const active = await listActiveCanaryTasks(db, skillCategoryId);
  if (active.length === 0) return null;
  return active[Math.floor(Math.random() * active.length)] ?? null;
}
