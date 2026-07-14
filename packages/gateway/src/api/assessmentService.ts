import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { EngineClient, ScoreResponse } from "../engine/engineClient.js";
import { discoverCandidates, hydrateServices, upsertAgent, upsertServices, type CandidateAgent } from "../okx/registry.js";
import type { OnchainosClient } from "../okx/onchainosClient.js";
import type { RankedCandidate } from "./contracts.js";

export interface BuildShortlistParams {
  taskSummary: string;
  skillCategoryId: string | null;
  maxCandidates: number;
}

export interface BuildShortlistDeps {
  client: OnchainosClient;
  db: Kysely<Database>;
  engine: EngineClient;
}

const DEFAULT_SKILL_CATEGORY = "general";

/**
 * Core shortlist-production pipeline shared by the fast A2MCP lookup, the
 * human web API, and the first pass of the A2A deep-assessment flow — see
 * spec §4.1: the two channels differ in latency/negotiation, not in what
 * evaluation logic runs.
 */
export async function buildShortlist(deps: BuildShortlistDeps, params: BuildShortlistParams): Promise<RankedCandidate[]> {
  const skillCategoryId = params.skillCategoryId ?? DEFAULT_SKILL_CATEGORY;
  await ensureSkillCategory(deps.db, skillCategoryId);

  const discovered = await hydrateServices(deps.client, await discoverCandidates(deps.client, params.taskSummary));
  const wideNet = discovered.slice(0, Math.max(params.maxCandidates * 3, 10));

  const scored = await Promise.all(
    wideNet.map(async (candidate) => {
      const agentRowId = await upsertAgent(deps.db, candidate);
      await upsertServices(deps.db, agentRowId, candidate.services, skillCategoryId);
      const score = await deps.engine.score(agentRowId, skillCategoryId);
      return { candidate, agentRowId, score };
    })
  );

  scored.sort((a, b) => b.score.score - a.score.score);
  const top = scored.slice(0, params.maxCandidates);

  return Promise.all(
    top.map(async ({ candidate, agentRowId, score }) => ({
      agent_id: candidate.okxAgentId,
      agent_name: candidate.name,
      fit_reasoning: buildFitReasoning(candidate, score),
      evidence_summary: await buildEvidenceSummary(deps.db, agentRowId, skillCategoryId, score),
      confidence_bucket: score.confidence_bucket,
      score: score.score,
      recommended_terms: score.recommended_terms
    }))
  );
}

async function ensureSkillCategory(db: Kysely<Database>, id: string): Promise<void> {
  await db
    .insertInto("skill_categories")
    .values({ id, name: id, decay_half_life_days: 30 })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

export function buildFitReasoning(candidate: CandidateAgent, score: ScoreResponse): string {
  const via = candidate.services.length > 0 ? `offers a matching service (${candidate.services[0]?.name ?? "unnamed service"})` : "was surfaced by OKX's registry search";
  const bucketLabel = score.confidence_bucket.replace("_", " ");
  const divergenceNote = score.divergence_flag ? " Canary performance and real-outcome history disagree here — treat this candidate's evidence as mixed, not settled." : "";
  const driftNote = score.recent_vs_historical_delta !== null && Math.abs(score.recent_vs_historical_delta) >= 0.15
    ? ` Recent performance has shifted ${score.recent_vs_historical_delta > 0 ? "up" : "down"} from its historical baseline — worth a second look before relying on the long-run average.`
    : "";
  return `This agent ${via} for the requested task. Confidence: ${bucketLabel}.${divergenceNote}${driftNote}`;
}

async function buildEvidenceSummary(db: Kysely<Database>, agentRowId: string, skillCategoryId: string, score: ScoreResponse) {
  const [canaryAgg, outcomeAgg, latestConsistency] = await Promise.all([
    db
      .selectFrom("canary_results")
      .select((eb) => [eb.fn.avg("score").as("avg_score"), eb.fn.count("id").as("n")])
      .where("agent_id", "=", agentRowId)
      .where("skill_category_id", "=", skillCategoryId)
      .executeTakeFirst(),
    db
      .selectFrom("outcome_ledger_entries")
      .select((eb) => [
        eb.fn.count("id").as("n"),
        eb.fn.sum(eb.case().when("resolution", "=", "disputed_against_agent").then(1).else(0).end()).as("disputes_against")
      ])
      .where("agent_id", "=", agentRowId)
      .executeTakeFirst(),
    db.selectFrom("consistency_runs").select(["stdev"]).where("agent_id", "=", agentRowId).where("skill_category_id", "=", skillCategoryId).orderBy("created_at", "desc").limit(1).executeTakeFirst()
  ]);

  const stdev = latestConsistency?.stdev ?? null;
  const consistencyLevel: "low" | "medium" | "high" | "unknown" = stdev === null ? "unknown" : stdev >= 0.2 ? "high" : stdev >= 0.1 ? "medium" : "low";

  return {
    canary_score_this_category: canaryAgg?.avg_score !== undefined && canaryAgg?.avg_score !== null ? Number(canaryAgg.avg_score) : null,
    tasks_completed_this_category: Number(outcomeAgg?.n ?? 0),
    disputes_against: Number(outcomeAgg?.disputes_against ?? 0),
    consistency_variance: consistencyLevel,
    divergence_flag: score.divergence_flag,
    recent_vs_historical_delta: score.recent_vs_historical_delta
  };
}

export async function persistAssessment(
  db: Kysely<Database>,
  params: { channel: "a2mcp" | "a2a"; taskSummary: string; skillCategoryId: string | null; acceptanceCriteria: unknown; requesterIdentifier: string | null; candidates: RankedCandidate[]; feeStatus: "pending" | "released" | "not_applicable" }
): Promise<string> {
  const row = await db
    .insertInto("assessments")
    .values({
      channel: params.channel,
      task_summary: params.taskSummary,
      skill_category_id: params.skillCategoryId,
      acceptance_criteria: params.acceptanceCriteria ? JSON.stringify(params.acceptanceCriteria) : null,
      requester_identifier: params.requesterIdentifier,
      ranked_candidates: JSON.stringify(params.candidates),
      fee_status: params.feeStatus
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}
