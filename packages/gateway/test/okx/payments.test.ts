import { describe, expect, it } from "vitest";
import { buildChallenge, verifyPayment, type X402Config } from "../../src/okx/payments.js";

const config: X402Config = {
  network: "eip155:196",
  payToAddress: "0xassay",
  assetAddress: "0xusdt",
  priceAtomic: "10000"
};

describe("x402 payments", () => {
  it("builds a spec-shaped 402 challenge", () => {
    const challenge = buildChallenge(config, "/v1/lookup");
    expect(challenge.x402Version).toBe(1);
    expect(challenge.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:196",
      payTo: "0xassay",
      asset: "0xusdt",
      maxAmountRequired: "10000",
      resource: "/v1/lookup"
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
