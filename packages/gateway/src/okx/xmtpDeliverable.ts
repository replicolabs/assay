import { execFile } from "node:child_process";

/**
 * A2A/escrow deliverables do NOT go through `onchainos`'s `task-deliverable-list`
 * at all — live-verified: it returns an empty list even after a task reaches
 * `submitted`. The actual content arrives as an encrypted file attachment over
 * OKX.AI's separate A2A messaging layer (XMTP), reachable only through the
 * `okx-a2a` CLI (a different binary from `onchainos`, the one set up for
 * agent-identity activation). This module is the fallback path for exactly
 * that case — x402/A2MCP deliverables never need it, since x402 embeds the
 * deliverable directly in the payment response (see onchainosClient.task402Pay).
 */

interface A2ATaskRequestMessage {
  content: string;
  sentAt: number;
}

interface A2ATaskRequestEntry {
  jobId: string;
  messages: A2ATaskRequestMessage[];
}

interface A2ATaskRequestsResponse {
  ok: boolean;
  payload?: A2ATaskRequestEntry[];
}

interface ParsedDeliverEnvelope {
  fileKey: string;
  digest: string;
  salt: string;
  nonce: string;
  secret: string;
  filename: string;
}

function runOkxA2a(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("okx-a2a", args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`okx-a2a ${args.join(" ")} failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * The inner XMTP message content is plain `key: value` lines, not JSON —
 * live-verified format, e.g.:
 *   jobId: 0x...
 *   deliverableType: file
 *   fileKey: 0x.../0x...-<uuid>
 *   digest: <hex>
 *   salt: <base64>
 *   nonce: <base64>
 *   secret: <base64>
 *   filename: report.md
 *   [intent:deliver]
 */
function parseDeliverEnvelope(text: string): ParsedDeliverEnvelope | null {
  if (!text.includes("[intent:deliver]")) return null;
  const get = (key: string) => text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const fileKey = get("fileKey");
  const digest = get("digest");
  const salt = get("salt");
  const nonce = get("nonce");
  const secret = get("secret");
  if (!fileKey || !digest || !salt || !nonce || !secret) return null;
  return { fileKey, digest, salt, nonce, secret, filename: get("filename") ?? "deliverable" };
}

/**
 * Looks for a pending `[intent:deliver]` XMTP message for this job, and if
 * found, downloads and decrypts the attached file. Returns the local path of
 * the decrypted file, or null if no such message exists yet (e.g. the ASP
 * hasn't actually delivered, as opposed to just accepting).
 *
 * `receivingAgentId` must be the *buyer's* OKX agent id — the XMTP identity
 * whose key the attachment was encrypted for, not the ASP being graded.
 */
export async function fetchA2ADeliverablePath(jobId: string, receivingAgentId: string): Promise<string | null> {
  const raw = await runOkxA2a(["task", "requests", "--json"]);
  const parsed = JSON.parse(raw) as A2ATaskRequestsResponse;
  const entry = parsed.payload?.find((p) => p.jobId === jobId);
  if (!entry) return null;

  for (const msg of entry.messages) {
    let inner: { content?: string } | undefined;
    try {
      inner = JSON.parse(msg.content) as { content?: string };
    } catch {
      continue;
    }
    const envelope = inner?.content ? parseDeliverEnvelope(inner.content) : null;
    if (!envelope) continue;

    const path = await runOkxA2a([
      "file",
      "download",
      "--file-key",
      envelope.fileKey,
      "--agent-id",
      receivingAgentId,
      "--digest",
      envelope.digest,
      "--salt",
      envelope.salt,
      "--nonce",
      envelope.nonce,
      "--secret",
      envelope.secret,
      "--filename",
      envelope.filename
    ]);
    return path.trim();
  }
  return null;
}
