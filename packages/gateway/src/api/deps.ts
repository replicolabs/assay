import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { EngineClient } from "../engine/engineClient.js";
import type { LLMClient } from "../intake/llmClient.js";
import type { OnchainosClient } from "../okx/onchainosClient.js";
import type { X402Config } from "../okx/payments.js";

export interface AppDeps {
  client: OnchainosClient;
  db: Kysely<Database>;
  engine: EngineClient;
  llm: LLMClient;
  x402: X402Config;
  /** Assay's own OKX.AI User Agent identity — the buyer role used to publish canary tasks. */
  buyerAgentId: string;
}
