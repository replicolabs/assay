import { afterEach, describe, expect, it, vi } from "vitest";

// The shortlist pipeline needs a real Postgres + onchainos client; this test
// is about the x402 payment gate in front of it, not the pipeline itself, so
// the pipeline functions lookup.ts calls directly are stubbed out here.
vi.mock("../../src/api/assessmentService.js", () => ({
  buildShortlist: vi.fn(async () => [
    {
      agent_id: "1001",
      agent_name: "SolWatch Auditor",
      fit_reasoning: "matches",
      evidence_summary: {
        canary_score_this_category: 0.8,
        tasks_completed_this_category: 3,
        disputes_against: 0,
        consistency_variance: "low",
        divergence_flag: false,
        recent_vs_historical_delta: null
      },
      confidence_bucket: "proven",
      score: 0.8,
      recommended_terms: { escrow_split: "50/50", milestone_structure: "single_delivery", holdback_pct: 0.5, require_stricter_acceptance_criteria: false }
    }
  ]),
  persistAssessment: vi.fn(async () => "req-123")
}));

const { buildApp } = await import("../../src/api/app.js");
const { buildShortlist } = await import("../../src/api/assessmentService.js");
import type { AppDeps } from "../../src/api/deps.js";
import type { X402Config } from "../../src/okx/payments.js";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const x402: X402Config = {
  network: "eip155:196",
  payToAddress: "0xassay",
  assetAddress: "0xusdt",
  priceAtomic: "10000",
  assetName: "USD₮0",
  assetVersion: "1",
  publicBaseUrl: "https://api.useassay.xyz",
  facilitator: { baseUrl: "https://web3.okx.com", apiKey: "k", secretKey: "s", passphrase: "p" }
};

function deps(): AppDeps {
  return {
    client: {} as AppDeps["client"],
    db: {} as AppDeps["db"],
    engine: {} as AppDeps["engine"],
    llm: {} as AppDeps["llm"],
    x402,
    buyerAgentId: "5585",
    aspAgentId: "5586"
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("POST /v1/lookup — x402 payment gate", () => {
  it("responds 402 with a spec-shaped challenge when no X-PAYMENT header is sent", async () => {
    const app = buildApp(deps());
    const res = await app.inject({ method: "POST", url: "/v1/lookup", payload: { task_summary: "audit my contract" } });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.x402Version).toBe(2);
    expect(body.reason).toMatch(/PAYMENT-SIGNATURE/);
    expect(res.headers["payment-required"]).toBeTruthy();
    expect(buildShortlist).not.toHaveBeenCalled();
  });

  it("verifies, settles, and delivers the shortlist for a valid paid replay (the reviewer's exact scenario)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/verify")) return jsonResponse({ code: "0", data: { isValid: true, payer: "0xbuyer" } });
      if (url.endsWith("/settle")) return jsonResponse({ code: "0", data: { success: true, status: "success", transaction: "0xtx" } });
      throw new Error(`unexpected facilitator call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp(deps());
    const paymentHeader = Buffer.from(JSON.stringify({ scheme: "exact", payload: { authorization: {} } })).toString("base64");
    // PAYMENT-SIGNATURE is the real v2 header name (OKX's Agent Payments
    // Protocol skill, `payment pay --payment-id` path) — X-PAYMENT is legacy
    // v1 only. A live task-402-pay replay against this exact header name was
    // what OKX's reviewer actually sent and we were rejecting.
    const res = await app.inject({
      method: "POST",
      url: "/v1/lookup",
      headers: { "payment-signature": paymentHeader },
      payload: { task_summary: "audit my contract" }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.request_id).toBe("req-123");
    expect(body.candidates[0].agent_name).toBe("SolWatch Auditor");
    expect(res.headers["payment-response"]).toBeTruthy();
    expect(buildShortlist).toHaveBeenCalledTimes(1);

    const settleCall = fetchMock.mock.calls.find(([url]) => (url as string).endsWith("/settle"));
    expect(settleCall).toBeTruthy();
  });

  it("also accepts the legacy X-PAYMENT header name for a v1-style client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/verify")) return jsonResponse({ code: "0", data: { isValid: true } });
        if (url.endsWith("/settle")) return jsonResponse({ code: "0", data: { success: true, status: "success", transaction: "0xtx" } });
        throw new Error(`unexpected facilitator call: ${url}`);
      })
    );

    const app = buildApp(deps());
    const paymentHeader = Buffer.from(JSON.stringify({ scheme: "exact" })).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/v1/lookup",
      headers: { "x-payment": paymentHeader },
      payload: { task_summary: "audit my contract" }
    });

    expect(res.statusCode).toBe(200);
    expect(buildShortlist).toHaveBeenCalledTimes(1);
  });

  it("responds 402 again (not 200) when verification passes but settlement fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/verify")) return jsonResponse({ code: "0", data: { isValid: true } });
        if (url.endsWith("/settle")) return jsonResponse({ code: "0", data: { success: false, errorMessage: "insufficient allowance" } });
        throw new Error(`unexpected facilitator call: ${url}`);
      })
    );

    const app = buildApp(deps());
    const paymentHeader = Buffer.from(JSON.stringify({ scheme: "exact" })).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/v1/lookup",
      headers: { "x-payment": paymentHeader },
      payload: { task_summary: "audit my contract" }
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toBe("insufficient allowance");
    expect(buildShortlist).not.toHaveBeenCalled();
  });
});
