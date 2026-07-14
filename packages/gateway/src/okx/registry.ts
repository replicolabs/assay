import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { OnchainosClient } from "./onchainosClient.js";
import type { AgentService } from "./types.js";

export interface CandidateAgent {
  okxAgentId: string;
  name: string;
  services: AgentService[];
  /** `asp_match` = OKX's own semantic matcher surfaced it; `search` = keyword broad net only. */
  discoveredVia: "asp_match" | "search";
}

/**
 * Candidate Discovery Engine (spec §4.1): casts a wide net, quality filtering
 * happens downstream in the Evaluation Engine, not here. `asp-match` is
 * OKX's own semantic ASP matcher (primary — it understands the task
 * description, not just keywords); `agent search` is a keyword broad net
 * that catches anything asp-match's semantic matching might have missed.
 */
export async function discoverCandidates(client: OnchainosClient, taskDesc: string): Promise<CandidateAgent[]> {
  const [matchResult, searchResult] = await Promise.all([
    client.aspMatch({ taskDesc }).catch(() => ({ recommendations: [] })),
    client.searchAgents(taskDesc).catch(() => ({ list: [], total: 0 }))
  ]);

  const byAgentId = new Map<string, CandidateAgent>();

  for (const rec of matchResult.recommendations) {
    const existing = byAgentId.get(rec.agentId);
    const service: AgentService = {
      serviceId: rec.serviceId,
      name: rec.serviceId,
      serviceType: rec.serviceType,
      fee: rec.feeAmount ?? null,
      endpoint: rec.endpoint ?? null,
      description: null
    };
    if (existing) {
      existing.services.push(service);
    } else {
      byAgentId.set(rec.agentId, {
        okxAgentId: rec.agentId,
        name: rec.agentId, // asp-match doesn't carry a display name; backfilled below if we also have a search row
        services: [service],
        discoveredVia: "asp_match"
      });
    }
  }

  for (const row of searchResult.list) {
    // `agent search` embeds each row's own services[] (serviceId/serviceName/
    // feeAmount/serviceType/endpoint/serviceDescription — live-verified),
    // so search-discovered candidates already have service detail without
    // a separate service-list round-trip; hydrateServices() below only needs
    // to fill in candidates that still come up empty (e.g. an asp-match hit
    // whose non-matched services weren't returned).
    const services: AgentService[] = (row.services ?? []).map((s) => ({
      serviceId: s.serviceId,
      name: s.serviceName,
      serviceType: s.serviceType,
      fee: s.feeAmount ?? null,
      endpoint: s.endpoint ?? null,
      description: s.serviceDescription ?? null
    }));

    const existing = byAgentId.get(row.agentId);
    if (existing) {
      if (existing.name === existing.okxAgentId) existing.name = row.name;
      if (existing.services.length === 0 && services.length > 0) existing.services = services;
    } else {
      byAgentId.set(row.agentId, {
        okxAgentId: row.agentId,
        name: row.name,
        services,
        discoveredVia: "search"
      });
    }
  }

  return [...byAgentId.values()];
}

/**
 * Backfills full service-list detail for any candidate whose services we
 * don't already have structured data for (search-only discovery, or
 * asp-match candidates missing pricing/description on their non-matched
 * services). One `service-list` call per agent needing it.
 */
export async function hydrateServices(client: OnchainosClient, candidates: CandidateAgent[]): Promise<CandidateAgent[]> {
  await Promise.all(
    candidates
      .filter((c) => c.services.length === 0)
      .map(async (c) => {
        try {
          c.services = await client.listServices(c.okxAgentId);
        } catch {
          // Leave services empty — this candidate just won't have service-level
          // detail for this discovery pass; it can still be scored on outcome
          // ledger / prior canary evidence alone.
        }
      })
  );
  return candidates;
}

export async function upsertAgent(db: Kysely<Database>, candidate: CandidateAgent, role: "user" | "asp" | "evaluator" = "asp"): Promise<string> {
  const row = await db
    .insertInto("agents")
    .values({
      okx_agent_id: candidate.okxAgentId,
      name: candidate.name,
      role,
      owner_address: null,
      status: "active"
    })
    .onConflict((oc) =>
      oc.column("okx_agent_id").doUpdateSet((eb) => ({
        name: eb.ref("excluded.name"),
        last_synced_at: new Date()
      }))
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function upsertServices(db: Kysely<Database>, agentRowId: string, services: AgentService[], skillCategoryId: string | null): Promise<void> {
  for (const s of services) {
    if (!s.serviceId) continue;
    await db
      .insertInto("agent_services")
      .values({
        agent_id: agentRowId,
        okx_service_id: s.serviceId,
        name: s.name,
        service_type: s.serviceType,
        fee_amount: s.fee !== null && s.fee !== undefined ? Number(s.fee) : null,
        fee_token: null,
        endpoint: s.endpoint ?? null,
        description: s.description ?? null,
        skill_category_id: skillCategoryId
      })
      .onConflict((oc) =>
        oc.columns(["agent_id", "okx_service_id"]).doUpdateSet((eb) => ({
          name: eb.ref("excluded.name"),
          fee_amount: eb.ref("excluded.fee_amount"),
          endpoint: eb.ref("excluded.endpoint"),
          description: eb.ref("excluded.description"),
          synced_at: new Date()
        }))
      )
      .execute();
  }
}
