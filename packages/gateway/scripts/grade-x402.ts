import { getDb } from "../src/db/client.js";
import { loadOnchainosConfig } from "../src/okx/config.js";
import { OnchainosClient } from "../src/okx/onchainosClient.js";
import { EngineClient } from "../src/engine/engineClient.js";
import { gradeDispatch } from "../src/canary/dispatcher.js";

const JOB_ID = "0xee3ff520964199e2f9294c17041a159cc4d7de4e1bc8f0a322b01008260de915";
const DISPATCH_ID = "9b8cc3f7-42fc-4c00-891a-335dae695a60";
const CANARY_TASK_ID = "a38c0a10-0811-4ff0-9f84-44b3543b2d7a";
const BUYER_AGENT_ID = "5585";

async function main() {
  const db = getDb();
  const client = new OnchainosClient(loadOnchainosConfig());
  const engine = new EngineClient();

  const canaryTask = await db.selectFrom("canary_tasks").selectAll().where("id", "=", CANARY_TASK_ID).executeTakeFirstOrThrow();

  const result = await gradeDispatch(client, engine, db, DISPATCH_ID, JOB_ID, canaryTask as never, "3640", "x402", BUYER_AGENT_ID);
  console.log("graded:", JSON.stringify(result));

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
