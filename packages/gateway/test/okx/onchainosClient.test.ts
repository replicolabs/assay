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
});
