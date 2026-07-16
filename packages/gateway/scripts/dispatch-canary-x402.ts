/**
 * Same purpose as dispatch-canary.ts, targeting SPOILER's A2MCP "Board
 * Snapshot" service — first live exercise of dispatchCanary's x402 branch
 * itself, as opposed to the hand-run CLI x402 flow used the first time.
 */
import { getDb } from "../src/db/client.js";
import { loadOnchainosConfig } from "../src/okx/config.js";
import { OnchainosClient } from "../src/okx/onchainosClient.js";
import { upsertAgent } from "../src/okx/registry.js";
import { createCanaryTask, listActiveCanaryTasks } from "../src/canary/bank.js";
import { dispatchCanary } from "../src/canary/dispatcher.js";

const TARGET_OKX_AGENT_ID = "3640"; // SPOILER
const TARGET_AGENT_NAME = "SPOILER";
const SERVICE_ID = "29395"; // "Board Snapshot"
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
        title: "Canary: board snapshot v2",
        description: "Fetch the current live board snapshot.",
        descriptionSummary: "Board snapshot canary via dispatcher",
        budget: "0.25",
        maxBudget: "0.28",
        currency: "USDT",
        serviceId: SERVICE_ID
      },
      // Same honest limitation as the first board-snapshot test: only checks
      // that proof_meter/receipts are present, not real pick quality.
      referenceOutput: { proof_meter: {}, receipts: [] }
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
