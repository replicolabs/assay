import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FacilitatorError,
  getSettleStatus,
  settleX402Payment,
  verifyX402Payment,
  type FacilitatorConfig
} from "../../src/okx/facilitatorClient.js";

const config: FacilitatorConfig = {
  baseUrl: "https://web3.okx.com",
  apiKey: "test-key",
  secretKey: "test-secret",
  passphrase: "test-pass"
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("facilitatorClient", () => {
  it("signs every request with OK-ACCESS headers and posts the expected body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: "0", data: { isValid: true, payer: "0xabc" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyX402Payment(config, { some: "payload" }, { scheme: "exact" });

    expect(result).toEqual({ isValid: true, payer: "0xabc" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://web3.okx.com/api/v6/pay/x402/verify");
    const headers = init.headers as Record<string, string>;
    expect(headers["OK-ACCESS-KEY"]).toBe("test-key");
    expect(headers["OK-ACCESS-PASSPHRASE"]).toBe("test-pass");
    expect(headers["OK-ACCESS-SIGN"]).toBeTruthy();
    expect(headers["OK-ACCESS-TIMESTAMP"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(init.body as string)).toMatchObject({
      x402Version: 2,
      paymentPayload: { some: "payload" },
      paymentRequirements: { scheme: "exact" }
    });
  });

  it("settleX402Payment posts to /settle and returns the parsed data", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://web3.okx.com/api/v6/pay/x402/settle");
      return jsonResponse({ code: "0", data: { success: true, status: "success", transaction: "0xtx" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await settleX402Payment(config, { some: "payload" }, { scheme: "exact" });
    expect(result).toEqual({ success: true, status: "success", transaction: "0xtx" });
  });

  it("getSettleStatus sends txHash as a query param on a GET with no body", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://web3.okx.com/api/v6/pay/x402/settle/status?txHash=0xtx");
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      return jsonResponse({ code: "0", data: { success: true, status: "success", transaction: "0xtx" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await getSettleStatus(config, "0xtx");
    expect(result.status).toBe("success");
  });

  it("throws FacilitatorError on a non-zero response code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "50001", msg: "signature invalid" }))
    );

    await expect(verifyX402Payment(config, {}, {})).rejects.toThrow(FacilitatorError);
    await expect(verifyX402Payment(config, {}, {})).rejects.toThrow(/signature invalid/);
  });

  it("throws FacilitatorError on an HTTP-level failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, false, 500))
    );

    await expect(settleX402Payment(config, {}, {})).rejects.toThrow(FacilitatorError);
  });

  it("treats a numeric code:0 (OKX's real wire format) as success, not an error", async () => {
    // Live-verified 2026-07-23: OKX's actual API returns `"code":0` as a JSON
    // number, not the string `"0"` their own docs example shows. A strict
    // `!== "0"` check silently swallowed every real successful response.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: 0, data: { isValid: true, payer: "0xabc" } }))
    );

    const result = await verifyX402Payment(config, {}, {});
    expect(result).toEqual({ isValid: true, payer: "0xabc" });
  });

  it("throws FacilitatorError on a numeric non-zero code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: 50001, msg: "signature invalid" }))
    );

    await expect(verifyX402Payment(config, {}, {})).rejects.toThrow(/signature invalid/);
  });
});
