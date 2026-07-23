/**
 * Assay's own x402 compliance as a *seller* — the A2MCP fast-lookup endpoint
 * must itself emit a valid HTTP 402 challenge so peer agents can pay it,
 * per the OKX Agent Payments Protocol (`accepts`-based v2, delivered via the
 * `PAYMENT-REQUIRED` header — live-verified against a real, currently-listed
 * XLayer A2MCP service via `onchainos agent x402-check`, which returned
 * x402Version:2 with `amount`/`extra.name`/`extra.version` fields, not the
 * legacy v1 body shape (`maxAmountRequired`, no `extra`) this module used to
 * emit. Rejection reason from OKX's own review confirmed the mismatch:
 * "This Agent has not passed x402 standard validation."
 *
 * `resource` is an OBJECT ({url, description, mimeType}), not a bare path
 * string — confirmed against OKX's own A2MCP dev docs example
 * (web3.okx.com/onchainos/dev-docs/okxai/howtokmcp), which this module
 * originally got wrong too (a second real v2-compliance bug, found only by
 * reading OKX's own reference example directly rather than re-testing our
 * already-"working" output).
 *
 * `verifyPayment` / `settlePayment` call OKX's own x402 facilitator
 * (`facilitatorClient.ts`) to actually verify the signed authorization and
 * settle it on-chain before content is delivered — see that module for the
 * real, sourced endpoint docs. Until `config.facilitator` is configured (real
 * OKX API credentials), both fail closed rather than silently accepting
 * anything — refusing everything until a real verifier exists is the safe
 * default, not a security hole waiting to happen.
 */

import { type FacilitatorConfig, getSettleStatus, settleX402Payment, verifyX402Payment } from "./facilitatorClient.js";

export interface X402Challenge {
  x402Version: 2;
  resource: { url: string; description: string; mimeType: string };
  accepts: Array<{
    scheme: "exact";
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    extra: { name: string; version: string };
    maxTimeoutSeconds: number;
  }>;
}

export interface X402Config {
  network: string; // e.g. "eip155:196" (XLayer)
  payToAddress: string; // Assay's own ASP wallet
  assetAddress: string; // USDT/USDG contract address on that network
  priceAtomic: string; // base-unit price for one /v1/lookup call
  // EIP-712 domain of the asset token, required by the `exact` scheme's
  // EIP-3009 signing path (accepts[].extra) — live-verified real values for
  // XLayer USDT are name:"USD₮0", version:"1".
  assetName: string;
  assetVersion: string;
  // Public base URL this gateway is reachable at (e.g. https://api.useassay.xyz)
  // — needed to build resource.url as a full absolute URL, per OKX's own spec
  // example, not a bare path.
  publicBaseUrl: string;
  // OKX x402 facilitator credentials (real Onchain OS Developer Portal API
  // key). Unset in fake/local-dev mode -> verify/settle fail closed.
  facilitator?: FacilitatorConfig;
}

function acceptEntry(config: X402Config): X402Challenge["accepts"][number] {
  return {
    scheme: "exact",
    network: config.network,
    amount: config.priceAtomic,
    asset: config.assetAddress,
    payTo: config.payToAddress,
    extra: { name: config.assetName, version: config.assetVersion },
    // OKX's own spec example uses 300s; matching their documented default
    // rather than our earlier arbitrary 60s.
    maxTimeoutSeconds: 300
  };
}

export function buildChallenge(config: X402Config, resourcePath: string): X402Challenge {
  return {
    x402Version: 2,
    resource: {
      url: `${config.publicBaseUrl}${resourcePath}`,
      description: "Assay ranked-shortlist lookup (A2MCP)",
      mimeType: "application/json"
    },
    accepts: [acceptEntry(config)]
  };
}

export type PaymentVerification = { valid: true; payload: unknown } | { valid: false; reason: string };

export async function verifyPayment(header: string | undefined, config: X402Config): Promise<PaymentVerification> {
  if (!header) {
    return { valid: false, reason: "missing PAYMENT-SIGNATURE (or legacy X-PAYMENT) header" };
  }
  if (!config.facilitator) {
    return { valid: false, reason: "no payment facilitator configured — see README §Setup (OKX_API_KEY/SECRET_KEY/PASSPHRASE)" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { valid: false, reason: "X-PAYMENT header is not valid base64-encoded JSON" };
  }
  if (typeof decoded !== "object" || decoded === null) {
    return { valid: false, reason: "X-PAYMENT payload is not a JSON object" };
  }

  try {
    const result = await verifyX402Payment(config.facilitator, decoded, acceptEntry(config));
    if (!result.isValid) {
      return { valid: false, reason: result.invalidMessage ?? result.invalidReason ?? "payment payload rejected by facilitator" };
    }
    return { valid: true, payload: decoded };
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : "facilitator verify call failed" };
  }
}

export type SettlementOutcome = { settled: true; txHash?: string } | { settled: false; reason: string };

/**
 * Synchronous settlement: waits for on-chain confirmation before the caller
 * delivers content, per the reviewer's own wording ("return 200 with content
 * after settlement") and to avoid handing over the paid resource before the
 * payment is actually final. OKX's docs describe this as one of two valid
 * modes (the other being async settle-in-background) — sync was the
 * deliberate choice here, not the only option.
 */
export async function settlePayment(
  payload: unknown,
  config: X402Config,
  opts: { pollTimeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<SettlementOutcome> {
  if (!config.facilitator) {
    return { settled: false, reason: "no payment facilitator configured" };
  }

  let result;
  try {
    result = await settleX402Payment(config.facilitator, payload, acceptEntry(config));
  } catch (err) {
    return { settled: false, reason: err instanceof Error ? err.message : "facilitator settle call failed" };
  }
  if (!result.success) {
    return { settled: false, reason: result.errorMessage ?? result.errorReason ?? "settlement rejected by facilitator" };
  }
  if (result.status === "success") {
    return { settled: true, txHash: result.transaction || undefined };
  }
  if (result.status === "failed") {
    return { settled: false, reason: "settlement failed on-chain" };
  }

  // status is still pending (e.g. batch settlement) — OKX's own docs: "intake
  // returns immediate acceptance but actual on-chain finality requires
  // separate status polling." Poll settle/status until it lands or we give up.
  if (!result.transaction) {
    return { settled: false, reason: "facilitator accepted settlement but returned no transaction to poll" };
  }
  const pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_500;
  const deadline = Date.now() + pollTimeoutMs;
  const txHash = result.transaction;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    try {
      const status = await getSettleStatus(config.facilitator, txHash);
      if (status.status === "success") {
        return { settled: true, txHash };
      }
      if (status.status === "failed") {
        return { settled: false, reason: "settlement failed on-chain" };
      }
    } catch {
      // transient facilitator error — keep polling until the deadline
    }
  }
  return { settled: false, reason: "settlement still pending after timeout — on-chain confirmation is taking longer than expected" };
}
