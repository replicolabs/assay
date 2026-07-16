/**
 * Runs the real outcome feedback loop (feedbackLoop.ts's reconcileAll)
 * against whatever routed/canary jobs are outstanding, using the real
 * onchainos CLI (ONCHAINOS_MODE=live). This is what turns terminal task
 * status into outcome_ledger_entries rows that the engine's scoring math
 * actually consumes.
 *
 * Usage (from packages/gateway):
 *   env ONCHAINOS_MODE=live npx tsx --env-file-if-exists=../../.env scripts/reconcile-all.ts
 */
import { getDb } from "../src/db/client.js";
import { loadOnchainosConfig } from "../src/okx/config.js";
import { OnchainosClient } from "../src/okx/onchainosClient.js";
import { reconcileAll } from "../src/outcome/feedbackLoop.js";

async function main() {
  const db = getDb();
  const client = new OnchainosClient(loadOnchainosConfig());

  const result = await reconcileAll(client, db);
  console.log("reconcileAll result:", JSON.stringify(result));

  const entries = await db
    .selectFrom("outcome_ledger_entries")
    .selectAll()
    .orderBy("occurred_at", "desc")
    .execute();
  console.log(`\n${entries.length} outcome_ledger_entries total:`);
  for (const e of entries) {
    console.log(`  agent_id=${e.agent_id} resolution=${e.resolution} job=${e.okx_job_id} amount=${e.escrow_amount} ${e.escrow_token}`);
  }

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
