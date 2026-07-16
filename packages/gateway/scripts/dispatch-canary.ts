/**
 * One-off operational script: seeds a real canary_task (if needed) and
 * dispatches it against a real target agent, through the actual production
 * code paths (dispatcher.ts, registry.ts, bank.ts) — not a hand-run CLI
 * command. There's no scheduler wiring these up automatically yet (a known
 * gap), so this is the manual trigger until one exists.
 *
 * Usage (from packages/gateway):
 *   npx tsx --env-file-if-exists=../../.env scripts/dispatch-canary.ts
 *
 * Edit the constants below per run — deliberately not CLI-arg-driven, since
 * this is meant to be reviewed before every real dispatch, not scripted in a
 * loop.
 */
import { getDb } from "../src/db/client.js";
import { loadOnchainosConfig } from "../src/okx/config.js";
import { OnchainosClient } from "../src/okx/onchainosClient.js";
import { upsertAgent } from "../src/okx/registry.js";
import { createCanaryTask, listActiveCanaryTasks } from "../src/canary/bank.js";
import { dispatchCanary } from "../src/canary/dispatcher.js";

const TARGET_OKX_AGENT_ID = "2993"; // TaskScout AI
const TARGET_AGENT_NAME = "TaskScout AI";
const SERVICE_ID = "28952"; // "Task Difficulty Analyzer"
const SKILL_CATEGORY_ID = "general";
const SKILL_CATEGORY_NAME = "General";

async function main() {
  const db = getDb();
  const client = new OnchainosClient(loadOnchainosConfig());

  await db
    .insertInto("skill_categories")
    .values({ id: SKILL_CATEGORY_ID, name: SKILL_CATEGORY_NAME, decay_half_life_days: 30 })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  const agentRowId = await upsertAgent(db, { okxAgentId: TARGET_OKX_AGENT_ID, name: TARGET_AGENT_NAME, services: [], discoveredVia: "search" }, "asp");
  console.log(`agent row: ${agentRowId} (okx ${TARGET_OKX_AGENT_ID})`);

  const existing = await listActiveCanaryTasks(db, SKILL_CATEGORY_ID);
  let canaryTaskId = existing.find((t) => (t.prompt_payload as { serviceId?: string })?.serviceId === SERVICE_ID)?.id;

  if (!canaryTaskId) {
    canaryTaskId = await createCanaryTask(db, {
      skillCategoryId: SKILL_CATEGORY_ID,
      gradingMode: "schema",
      promptPayload: {
        title: "Canary: task difficulty read",
        description:
          "Analyze this OKX.AI task and evaluate its difficulty: 'Build a Python script that fetches the top 5 gainers on a DEX and posts them to a Discord webhook every hour.' Report required data sources, ambiguity, dispute risk, estimated execution effort, and probability of acceptance.",
        descriptionSummary: "Difficulty analysis canary",
        budget: "0.02",
        maxBudget: "0.03",
        currency: "USDT",
        serviceId: SERVICE_ID
      },
      // Honest limitation, stated plainly: grade_schema checks that specific
      // named keys are present with a matching JSON *kind* (string vs object vs
      // etc.) — but we have no real prior sample of what TaskScout AI's
      // "Task Difficulty Analyzer" actually returns, so asserting specific key
      // names now would be guessing, not grading. An empty reference object
      // scores 1.0 for any valid JSON response (grade_schema's own short-circuit
      // for an empty required-keys set) — this exercises the real dispatch ->
      // deliverable -> grade -> complete pipeline faithfully, but the grade
      // itself is a "did it respond with valid JSON at all" check, not a
      // meaningful quality rubric. A real rubric needs a real sample first.
      referenceOutput: {}
    });
    console.log(`created canary_task: ${canaryTaskId}`);
  } else {
    console.log(`reusing existing canary_task: ${canaryTaskId}`);
  }

  const canaryTask = await db.selectFrom("canary_tasks").selectAll().where("id", "=", canaryTaskId).executeTakeFirstOrThrow();

  console.log("dispatching...");
  const result = await dispatchCanary(client, db, { agentRowId, okxAgentId: TARGET_OKX_AGENT_ID }, canaryTask as never);
  console.log(JSON.stringify(result, null, 2));

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
