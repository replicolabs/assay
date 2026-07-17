import { describe, expect, it } from "vitest";
import { buildChallenge, verifyPayment, type X402Config } from "../../src/okx/payments.js";

const config: X402Config = {
  network: "eip155:196",
  payToAddress: "0xassay",
  assetAddress: "0xusdt",
  priceAtomic: "10000",
  assetName: "USD₮0",
  assetVersion: "1"
};

describe("x402 payments", () => {
  it("builds a spec-shaped v2 402 challenge", () => {
    // Live-verified against a real, currently-listed XLayer A2MCP service
    // via `onchainos agent x402-check`: x402Version:2, `amount` (not
    // `maxAmountRequired`), top-level `resource`, and `extra.name`/`version`
    // (EIP-712 domain) per accepts entry.
    const challenge = buildChallenge(config, "/v1/lookup");
    expect(challenge.x402Version).toBe(2);
    expect(challenge.resource).toBe("/v1/lookup");
    expect(challenge.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:196",
      payTo: "0xassay",
      asset: "0xusdt",
      amount: "10000",
      extra: { name: "USD₮0", version: "1" }
    });
  });

  it("fails closed with no X-PAYMENT header", async () => {
    const result = await verifyPayment(undefined, config);
    expect(result.valid).toBe(false);
  });

  it("fails closed when no facilitator is configured, even with a header present", async () => {
    const fakePayload = Buffer.from(JSON.stringify({ scheme: "exact" })).toString("base64");
    const result = await verifyPayment(fakePayload, config);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/facilitator/);
    }
  });
});
