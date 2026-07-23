import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChallenge, settlePayment, verifyPayment, type X402Config } from "../../src/okx/payments.js";

const baseConfig: X402Config = {
  network: "eip155:196",
  payToAddress: "0xassay",
  assetAddress: "0xusdt",
  priceAtomic: "10000",
  assetName: "USD₮0",
  assetVersion: "1",
  publicBaseUrl: "https://api.useassay.xyz"
};

const configWithFacilitator: X402Config = {
  ...baseConfig,
  facilitator: { baseUrl: "https://web3.okx.com", apiKey: "k", secretKey: "s", passphrase: "p" }
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const fakeHeader = Buffer.from(JSON.stringify({ scheme: "exact" })).toString("base64");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("x402 payments", () => {
  it("builds a spec-shaped v2 402 challenge", () => {
    // Confirmed against OKX's own A2MCP dev docs example
    // (web3.okx.com/onchainos/dev-docs/okxai/howtokmcp): x402Version:2,
    // `amount` (not `maxAmountRequired`), `resource` as an OBJECT
    // {url, description, mimeType} with an absolute url (not a bare path),
    // and `extra.name`/`version` (EIP-712 domain) per accepts entry.
    const challenge = buildChallenge(baseConfig, "/v1/lookup");
    expect(challenge.x402Version).toBe(2);
    expect(challenge.resource).toMatchObject({
      url: "https://api.useassay.xyz/v1/lookup",
      mimeType: "application/json"
    });
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
    const result = await verifyPayment(undefined, baseConfig);
    expect(result.valid).toBe(false);
  });

  it("fails closed when no facilitator is configured, even with a header present", async () => {
    const result = await verifyPayment(fakeHeader, baseConfig);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/facilitator/);
    }
  });

  it("verifyPayment accepts a payload the facilitator confirms valid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "0", data: { isValid: true, payer: "0xbuyer" } }))
    );
    const result = await verifyPayment(fakeHeader, configWithFacilitator);
    expect(result.valid).toBe(true);
  });

  it("verifyPayment rejects a payload the facilitator marks invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "0", data: { isValid: false, invalidMessage: "amount too low" } }))
    );
    const result = await verifyPayment(fakeHeader, configWithFacilitator);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("amount too low");
    }
  });

  it("settlePayment returns settled:true immediately when the facilitator confirms on intake", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "0", data: { success: true, status: "success", transaction: "0xtx" } }))
    );
    const result = await settlePayment({ scheme: "exact" }, configWithFacilitator);
    expect(result).toEqual({ settled: true, txHash: "0xtx" });
  });

  it("settlePayment polls settle/status until the batch lands", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        call += 1;
        if (url.endsWith("/settle")) {
          return jsonResponse({ code: "0", data: { success: true, status: "pending", transaction: "0xtx" } });
        }
        // First status poll still pending, second one lands.
        const status = call < 3 ? "pending" : "success";
        return jsonResponse({ code: "0", data: { success: true, status, transaction: "0xtx" } });
      })
    );
    const result = await settlePayment({ scheme: "exact" }, configWithFacilitator, { pollIntervalMs: 0, pollTimeoutMs: 5000 });
    expect(result).toEqual({ settled: true, txHash: "0xtx" });
  });

  it("settlePayment fails when the facilitator rejects settlement outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "0", data: { success: false, errorMessage: "insufficient allowance" } }))
    );
    const result = await settlePayment({ scheme: "exact" }, configWithFacilitator);
    expect(result).toEqual({ settled: false, reason: "insufficient allowance" });
  });
});
