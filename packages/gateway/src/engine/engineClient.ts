/** Thin HTTP client for the Rust evaluation engine (packages/engine). */

export interface ScoreResponse {
  agent_id: string;
  skill_category_id: string;
  score: number;
  confidence_bucket: "unproven" | "emerging" | "proven" | "high_confidence";
  consistency_penalty: number;
  divergence_flag: boolean;
  recent_vs_historical_delta: number | null;
  recommended_terms: {
    escrow_split: string;
    milestone_structure: string;
    holdback_pct: number;
    require_stricter_acceptance_criteria: boolean;
  };
}

export interface ConsistencyVarianceResponse {
  mean: number;
  variance: number;
  stdev: number;
  high_variance: boolean;
  consistency_penalty: number;
}

export class EngineClient {
  constructor(private readonly baseUrl: string = process.env.ENGINE_URL ?? "http://127.0.0.1:8081") {}

  async score(agentId: string, skillCategoryId: string): Promise<ScoreResponse> {
    return this.post("/score", { agent_id: agentId, skill_category_id: skillCategoryId });
  }

  async gradeCanary(params: { canaryTaskId: string; dispatchId: string; agentId: string; skillCategoryId: string; output: unknown }): Promise<{ score: number }> {
    return this.post("/canary/grade", {
      canary_task_id: params.canaryTaskId,
      dispatch_id: params.dispatchId,
      agent_id: params.agentId,
      skill_category_id: params.skillCategoryId,
      output: params.output
    });
  }

  async consistencyVariance(params: { agentId: string; skillCategoryId: string; dispatchIds: string[]; scores: number[] }): Promise<ConsistencyVarianceResponse> {
    return this.post("/consistency/variance", {
      agent_id: params.agentId,
      skill_category_id: params.skillCategoryId,
      dispatch_ids: params.dispatchIds,
      scores: params.scores
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`engine ${path} returned ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }
}
