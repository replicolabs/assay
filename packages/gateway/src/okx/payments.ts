/**
 * Assay's own x402 compliance as a *seller* — the A2MCP fast-lookup endpoint
 * must itself emit a valid HTTP 402 challenge so peer agents can pay it,
 * per the OKX Agent Payments Protocol (`accepts`-based v1, since that's the
 * scheme documented end-to-end in okx-agent-payments-protocol/references/
 * accepts-schemes.md without needing a channel/session state machine).
 *
 * Honest scope boundary: this module emits a spec-shaped 402 challenge and
 * does presence/structural checks on a replayed `X-PAYMENT` header, but does
 * NOT perform on-chain signature/settlement verification — that requires a
 * facilitator (the OKX Payment SDK's server-side verify endpoint), which
 * needs credentials only the operator can provide (see README §Setup).
 * Until PAYMENT_FACILITATOR_URL is configured, `verifyPayment` always
 * returns invalid — fail-closed, not fail-open. A wrapper that "looks like"
 * it checks payment but silently accepts anything would be a real security
 * hole; refusing everything until a real verifier exists is the safe default.
 */

export interface X402Challenge {
  x402Version: 1;
  accepts: Array<{
    scheme: "exact";
    network: string;
    maxAmountRequired: string;
    resource: string;
    description: string;
    mimeType: string;
    payTo: string;
    asset: string;
    maxTimeoutSeconds: number;
  }>;
}

export interface X402Config {
  network: string; // e.g. "eip155:196" (XLayer)
  payToAddress: string; // Assay's own ASP wallet
  assetAddress: string; // USDT/USDG contract address on that network
  priceAtomic: string; // base-unit price for one /v1/lookup call
  facilitatorUrl?: string;
}

export function buildChallenge(config: X402Config, resource: string): X402Challenge {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: config.network,
        maxAmountRequired: config.priceAtomic,
        resource,
        description: "Assay ranked-shortlist lookup (A2MCP)",
        mimeType: "application/json",
        payTo: config.payToAddress,
        asset: config.assetAddress,
        maxTimeoutSeconds: 60
      }
    ]
  };
}

export type PaymentVerification = { valid: true } | { valid: false; reason: string };

export async function verifyPayment(header: string | undefined, config: X402Config): Promise<PaymentVerification> {
  if (!header) {
    return { valid: false, reason: "missing X-PAYMENT header" };
  }
  if (!config.facilitatorUrl) {
    return { valid: false, reason: "no payment facilitator configured — see README §Setup (PAYMENT_FACILITATOR_URL)" };
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

  const res = await fetch(config.facilitatorUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payment: decoded })
  }).catch(() => null);

  if (!res || !res.ok) {
    return { valid: false, reason: "facilitator rejected or was unreachable" };
  }
  return { valid: true };
}
