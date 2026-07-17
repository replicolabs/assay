import { describe, expect, it } from "vitest";
import { OnchainosClient } from "../../src/okx/onchainosClient.js";
import { loadOnchainosConfig } from "../../src/okx/config.js";
import { OnchainosBusinessError } from "../../src/okx/errors.js";

// Runs against test/fakes/onchainos (ONCHAINOS_MODE defaults to "fake" whenever
// unset, so no env setup needed — see config.ts).
const client = new OnchainosClient(loadOnchainosConfig({}));

describe("OnchainosClient against the fake CLI", () => {
  it("searches the registry and returns typed rows", async () => {
    const res = await client.searchAgents("audit");
    expect(res.total).toBeGreaterThan(0);
    expect(res.list.every((r) => typeof r.agentId === "string")).toBe(true);
  });

  it("fetches agent detail", async () => {
    const [agent] = await client.getAgents(["1001"]);
    expect(agent?.agentId).toBe("1001");
    expect(agent?.name).toBe("SolWatch Auditor");
  });

  it("lists services for an agent, unwrapped from the {agentInfo, list} envelope and field-renamed", async () => {
    // Live-verified: service-list responds {ok:true, data:{agentInfo, list}}, and each row
    // uses id/serviceName/serviceDescription/fee — the client normalizes these to the
    // serviceId/name/description shape the rest of the codebase expects.
    const services = await client.listServices("1001");
    expect(services).toHaveLength(1);
    expect(services[0]?.serviceType).toBe("a2a");
    expect(services[0]?.serviceId).toBe("1");
    expect(services[0]?.name).toBe("Smart Contract Audit");
    expect(services[0]?.description).toMatch(/reentrancy/);
  });

  it("surfaces a {ok:false, error} response as a typed business error, not a schema error", async () => {
    await expect(client.listServices("9999")).rejects.toThrow(OnchainosBusinessError);
    await expect(client.listServices("9999")).rejects.toThrow(/not found/);
  });

  it("exposes serviceMinPrice and the embedded services[] on search rows (not a flat topService/minPrice)", async () => {
    const res = await client.searchAgents("audit");
    const row = res.list.find((r) => r.agentId === "1001");
    expect(row?.serviceMinPrice).toBe(20);
    expect(row?.services?.[0]?.serviceName).toBe("Smart Contract Audit");
  });

  it("lists feedback with scores already 0-5", async () => {
    const feedback = await client.listFeedback("1002");
    expect(feedback.length).toBeGreaterThan(0);
    for (const f of feedback) {
      expect(f.score).toBeGreaterThanOrEqual(0);
      expect(f.score).toBeLessThanOrEqual(5);
    }
  });

  it("runs asp-match and gets recommendations", async () => {
    const res = await client.aspMatch({ taskDesc: "audit my contract" });
    expect(res.recommendations.length).toBeGreaterThan(0);
  });

  it("creates a task and returns a jobId", async () => {
    const res = await client.createTask({
      description: "Audit this Anchor program for reentrancy and PDA misuse, twenty chars min",
      budget: "20",
      maxBudget: "25",
      currency: "USDT",
      title: "Canary: Anchor audit",
      descriptionSummary: "Canary task",
      provider: "1001",
      visibility: 1
    });
    expect(res.jobId).toMatch(/^fake-job-/);
  });

  it("polls task status to a terminal state", async () => {
    const status = await client.taskStatus("fake-job-123");
    expect(status.status).toBe("completed");
  });

  it("throws OnchainosNotInstalledError for a bad binary path in live mode", async () => {
    const badClient = new OnchainosClient({ mode: "live", bin: "/nonexistent/onchainos-binary", timeoutMs: 5000 });
    await expect(badClient.searchAgents("x")).rejects.toThrow(/not found/);
  });

  it("fetches agent detail with onlineStatus, for the dispatch preflight check", async () => {
    const [online] = await client.getAgents(["1001"]);
    const [offline] = await client.getAgents(["1005"]);
    expect(online?.onlineStatus).toBe(1);
    expect(offline?.onlineStatus).toBe(2);
  });

  it("x402-check returns a parseable acceptsJson string, not a nested object", async () => {
    const check = await client.x402Check("https://x402.example/api/lookup");
    expect(check.valid).toBe(true);
    expect(() => JSON.parse(check.acceptsJson)).not.toThrow();
    const accepts = JSON.parse(check.acceptsJson);
    expect(Array.isArray(accepts)).toBe(true);
    expect(accepts[0]).toHaveProperty("payTo");
  });

  it("falls back to regex extraction when a command returns pretty console text instead of JSON", async () => {
    // Live-verified quirk: the same command with identical args has been observed
    // returning both JSON and human-readable text ("✓ Draft saved (jobId: ...)")
    // across different runs — this must not surface as a hard parse failure.
    const draft = await client.draftCreate({
      title: "PRETTY_TEXT_TEST",
      description: "irrelevant",
      descriptionSummary: "irrelevant"
    });
    expect(draft.jobId).toBe("0xfa4e9012");
  });

  it("task-402-pay returns the deliverable inline via replayBody", async () => {
    const paid = await client.task402Pay("fake-job-x402", {
      providerAgentId: "1006",
      accepts: JSON.stringify([{ amount: "50000", asset: "0xfakeusdt", network: "eip155:196", payTo: "0xfakepayto", scheme: "exact" }]),
      endpoint: "https://x402.example/api/lookup",
      tokenSymbol: "USDT",
      tokenAmount: "0.05"
    });
    expect(paid.replayBody).toBeTruthy();
    expect(paid.deliverableSavedPath).toBeTruthy();
  });

  it("heartbeat resolves without throwing", async () => {
    await expect(client.heartbeat(196)).resolves.toBeUndefined();
  });
});
