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
  facilitatorUrl?: string;
}

export function buildChallenge(config: X402Config, resourcePath: string): X402Challenge {
  return {
    x402Version: 2,
    resource: {
      url: `${config.publicBaseUrl}${resourcePath}`,
      description: "Assay ranked-shortlist lookup (A2MCP)",
      mimeType: "application/json"
    },
    accepts: [
      {
        scheme: "exact",
        network: config.network,
        amount: config.priceAtomic,
        asset: config.assetAddress,
        payTo: config.payToAddress,
        extra: { name: config.assetName, version: config.assetVersion },
        // OKX's own spec example uses 300s; matching their documented default
        // rather than our earlier arbitrary 60s.
        maxTimeoutSeconds: 300
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
