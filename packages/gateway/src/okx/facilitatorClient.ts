/**
 * Client for OKX's own x402 facilitator — the seller-side REST API that
 * verifies and settles incoming payment authorizations, so Assay doesn't
 * need its own blockchain connectivity to accept payment.
 *
 * Source: OKX's Onchain OS docs (web3.okx.com/onchainos/dev-docs/payments/
 * api-http-batch), which this module's earlier version never actually called
 * — `verifyPayment` was a fail-closed stub gated on an unset
 * `PAYMENT_FACILITATOR_URL`, which is the root cause a real OKX reviewer hit:
 * paid replays to /v1/lookup always got 402'd back, never 200. Confirmed real
 * (not guessed) endpoints:
 *   GET  /api/v6/pay/x402/supported     — lists supported schemes/networks
 *   POST /api/v6/pay/x402/verify        — validates a payment payload
 *   POST /api/v6/pay/x402/settle        — submits it for on-chain settlement
 *   GET  /api/v6/pay/x402/settle/status — polls settlement by txHash
 * Auth: OK-ACCESS-KEY/SIGN/PASSPHRASE/TIMESTAMP headers — OKX's standard API
 * signing scheme (HMAC-SHA256 of `timestamp+method+requestPath+body`, base64
 * encoded). Same Developer Portal credentials already used for the
 * `onchainos` CLI's AK login (OKX_API_KEY/SECRET_KEY/PASSPHRASE) — both this
 * API and the CLI live under the same Onchain OS Developer Portal, but this
 * assumption is NOT yet live-verified against a real paid request; treat a
 * 401/signature-invalid response as evidence it needs its own key instead.
 */
import { createHmac } from "node:crypto";

export interface FacilitatorConfig {
  baseUrl: string; // e.g. https://web3.okx.com
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string | null;
  invalidMessage?: string | null;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  errorReason?: string | null;
  errorMessage?: string | null;
  payer?: string;
  transaction?: string;
  status: "success" | "pending" | "failed" | string;
}

export interface SettleStatusResult {
  success: boolean;
  payer?: string;
  transaction?: string;
  status: "pending" | "success" | "failed" | string;
}

export class FacilitatorError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(`OKX x402 facilitator error ${code}: ${message}`);
    this.name = "FacilitatorError";
  }
}

function sign(timestamp: string, method: string, requestPath: string, body: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(`${timestamp}${method}${requestPath}${body}`).digest("base64");
}

async function okxRequest<T>(config: FacilitatorConfig, method: "GET" | "POST", requestPath: string, body?: unknown): Promise<T> {
  const timestamp = new Date().toISOString();
  const bodyStr = body !== undefined ? JSON.stringify(body) : "";
  const signature = sign(timestamp, method, requestPath, bodyStr, config.secretKey);

  const res = await fetch(`${config.baseUrl}${requestPath}`, {
    method,
    headers: {
      "content-type": "application/json",
      "OK-ACCESS-KEY": config.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-PASSPHRASE": config.passphrase,
      "OK-ACCESS-TIMESTAMP": timestamp
    },
    body: method === "GET" ? undefined : bodyStr
  });

  const json = (await res.json()) as { code?: string | number; msg?: string; data?: T };
  // Live-verified 2026-07-23: OKX returns `code` as a JSON *number* (`0`),
  // not the string `"0"` shown in their own docs example — a strict `!== "0"`
  // check silently treated every successful response as an error (masking
  // the real verify/settle result behind an empty "error 0:" message).
  // String-compare both sides so either representation is accepted.
  if (!res.ok || String(json.code) !== "0") {
    throw new FacilitatorError(String(json.code ?? res.status), json.msg ?? `HTTP ${res.status}`);
  }
  return json.data as T;
}

export async function verifyX402Payment(
  config: FacilitatorConfig,
  paymentPayload: unknown,
  paymentRequirements: unknown
): Promise<VerifyResult> {
  return okxRequest<VerifyResult>(config, "POST", "/api/v6/pay/x402/verify", {
    x402Version: 2,
    paymentPayload,
    paymentRequirements
  });
}

export async function settleX402Payment(
  config: FacilitatorConfig,
  paymentPayload: unknown,
  paymentRequirements: unknown
): Promise<SettleResult> {
  return okxRequest<SettleResult>(config, "POST", "/api/v6/pay/x402/settle", {
    x402Version: 2,
    paymentPayload,
    paymentRequirements
  });
}

export async function getSettleStatus(config: FacilitatorConfig, txHash: string): Promise<SettleStatusResult> {
  const path = `/api/v6/pay/x402/settle/status?txHash=${encodeURIComponent(txHash)}`;
  return okxRequest<SettleStatusResult>(config, "GET", path);
}
