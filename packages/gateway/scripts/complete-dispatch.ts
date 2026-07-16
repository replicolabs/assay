import { readFile } from "node:fs/promises";
import { getDb } from "../src/db/client.js";
import { loadOnchainosConfig } from "../src/okx/config.js";
import { OnchainosClient } from "../src/okx/onchainosClient.js";
import { EngineClient } from "../src/engine/engineClient.js";

const JOB_ID = "0x3e1cc2b32ab001378354a69bcf61d03aafd87e608c14d0f28797fdafc7413be4";
const DISPATCH_ID = "44a3a249-73f9-4e4e-ba4c-916628759721";
const CANARY_TASK_ID = "3fd0478b-fff5-4670-8ef2-4c93493b8c41";
const AGENT_ROW_ID = "3e3a941d-2f3c-4c68-92c0-5fa1d78c3545";
const SKILL_CATEGORY_ID = "general";
const DELIVERABLE_PATH = "/home/dav/.okx-agent-task/downloads/task-difficulty-analysis.md";

async function main() {
  const db = getDb();
  const client = new OnchainosClient(loadOnchainosConfig());
  const engine = new EngineClient();

  const raw = await readFile(DELIVERABLE_PATH, "utf8");
  // Real content is markdown prose, not JSON — same tryParseJson-fallback shape
  // gradeDispatch already uses for non-JSON deliverables.
  const output = { fileText: raw };

  console.log("grading via real engine /canary/grade...");
  const graded = await engine.gradeCanary({
    canaryTaskId: CANARY_TASK_ID,
    dispatchId: DISPATCH_ID,
    agentId: AGENT_ROW_ID,
    skillCategoryId: SKILL_CATEGORY_ID,
    output
  });
  console.log("grade:", JSON.stringify(graded));

  console.log("releasing escrow via client.complete()...");
  await client.complete(JOB_ID);
  console.log("complete() succeeded");

  await db.updateTable("canary_dispatches").set({ status: "graded", graded_at: new Date() }).where("id", "=", DISPATCH_ID).execute();
  console.log("dispatch marked graded");

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
