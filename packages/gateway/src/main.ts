import { buildApp } from "./api/app.js";
import type { AppDeps } from "./api/deps.js";
import { getDb } from "./db/client.js";
import { EngineClient } from "./engine/engineClient.js";
import { AnthropicLLMClient, NullLLMClient } from "./intake/llmClient.js";
import { OnchainosClient } from "./okx/onchainosClient.js";
import { loadOnchainosConfig } from "./okx/config.js";
import { startHeartbeatLoop } from "./okx/heartbeatLoop.js";
import type { X402Config } from "./okx/payments.js";

function loadDeps(): AppDeps {
  const onchainosConfig = loadOnchainosConfig();
  const client = new OnchainosClient(onchainosConfig);
  const db = getDb();
  const engine = new EngineClient();
  const llm = process.env.ANTHROPIC_API_KEY ? new AnthropicLLMClient() : new NullLLMClient();

  const x402: X402Config = {
    network: process.env.X402_NETWORK ?? "eip155:196",
    payToAddress: process.env.ASSAY_ASP_PAYOUT_ADDRESS ?? "",
    assetAddress: process.env.X402_ASSET_ADDRESS ?? "",
    priceAtomic: process.env.X402_LOOKUP_PRICE_ATOMIC ?? "10000", // 0.01 USDT at 6 decimals, by default
    // Live-verified EIP-712 domain for XLayer USDT (USD₮0) via a real
    // `agent x402-check` against another listed A2MCP service.
    assetName: process.env.X402_ASSET_NAME ?? "USD₮0",
    assetVersion: process.env.X402_ASSET_VERSION ?? "1",
    facilitatorUrl: process.env.PAYMENT_FACILITATOR_URL
  };

  const buyerAgentId = process.env.ASSAY_BUYER_AGENT_ID ?? "";

  return { client, db, engine, llm, x402, buyerAgentId };
}

async function main() {
  const deps = loadDeps();
  const app = buildApp(deps);

  // Fake mode's test double doesn't implement `agent heartbeat` — only run
  // this against the real CLI/backend.
  if (loadOnchainosConfig().mode === "live") {
    const chainIndex = Number(deps.x402.network.split(":")[1] ?? "196");
    startHeartbeatLoop(deps.client, chainIndex);
  }

  // GATEWAY_HTTP_ADDR wins when set; falls back to Railway's PORT convention
  // (this service gets a public Railway domain, so Railway's assigned PORT is
  // what its edge proxy actually targets), then a plain local-dev default.
  const addr = process.env.GATEWAY_HTTP_ADDR ?? (process.env.PORT ? `0.0.0.0:${process.env.PORT}` : "127.0.0.1:8080");
  const [host, portStr] = addr.split(":");
  await app.listen({ host: host || "0.0.0.0", port: Number(portStr) || 8080 });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
