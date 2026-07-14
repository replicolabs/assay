import { execFile } from "node:child_process";
import type { z } from "zod";
import { loadOnchainosConfig, type OnchainosConfig } from "./config.js";
import {
  OnchainosBusinessError,
  OnchainosExecError,
  OnchainosNotInstalledError,
  OnchainosParseError,
  OnchainosSchemaError
} from "./errors.js";
import {
  AgentDetailListSchema,
  AgentSearchResponseSchema,
  AgentServiceListResponseSchema,
  AckResponseSchema,
  AspMatchResponseSchema,
  CreateTaskResponseSchema,
  DeliverableListResponseSchema,
  DraftResponseSchema,
  EnvelopeSchema,
  FeedbackListResponseSchema,
  TaskSearchResponseSchema,
  TaskStatusSchema,
  type AgentDetail,
  type AgentSearchResponse,
  type AgentService,
  type AspMatchResponse,
  type CreateTaskResponse,
  type Deliverable,
  type DraftResponse,
  type FeedbackItem,
  type TaskSearchResponse,
  type TaskStatus
} from "./types.js";

/**
 * Thin wrapper over the real `onchainos` CLI — OKX.AI's actual integration
 * surface (there is no separate public REST API; see README §OKX.AI
 * integration). Every subcommand used here is documented in
 * github.com/okx/onchainos-skills (skills/okx-ai/references/*.md).
 *
 * One method = one CLI invocation = one JSON-parsed, schema-validated result.
 * Never shells out and greps/jq's the output — the CLI's own JSON is the
 * contract (mirrors the "no-shell-stitching" rule the CLI's own skill docs
 * enforce on LLM callers, which is good discipline for a script caller too).
 */
export class OnchainosClient {
  constructor(private readonly config: OnchainosConfig = loadOnchainosConfig()) {}

  // --- Registry -------------------------------------------------------------

  async searchAgents(query: string, opts: { page?: number; service?: string } = {}): Promise<AgentSearchResponse> {
    const args = ["agent", "search", "--query", query];
    if (opts.page) args.push("--page", String(opts.page));
    if (opts.service) args.push("--service", opts.service);
    return this.run(args, AgentSearchResponseSchema);
  }

  async getAgents(agentIds: string[]): Promise<AgentDetail[]> {
    return this.run(["agent", "get-agents", "--agent-ids", agentIds.join(",")], AgentDetailListSchema);
  }

  async listServices(agentId: string): Promise<AgentService[]> {
    return this.run(["agent", "service-list", "--agent-id", agentId], AgentServiceListResponseSchema);
  }

  async listFeedback(agentId: string, page = 1): Promise<FeedbackItem[]> {
    return this.run(["agent", "feedback-list", "--agent-id", agentId, "--page", String(page)], FeedbackListResponseSchema);
  }

  async aspMatch(params: {
    taskDesc?: string;
    jobId?: string;
    providerAgentId?: string;
    agentId?: string;
  }): Promise<AspMatchResponse> {
    const args = ["agent", "asp-match", "--format", "json"];
    if (params.taskDesc) args.push("--task-desc", params.taskDesc);
    if (params.jobId) args.push("--job-id", params.jobId);
    if (params.providerAgentId) args.push("--provider-agent-id", params.providerAgentId);
    if (params.agentId) args.push("--agent-id", params.agentId);
    return this.run(args, AspMatchResponseSchema);
  }

  // --- Task pool / status -----------------------------------------------------

  async taskSearch(params: {
    keyword?: string;
    status?: string;
    page?: number;
    pageSize?: number;
    agentId: string;
  }): Promise<TaskSearchResponse> {
    const args = ["agent", "task-search", "--agent-id", params.agentId];
    if (params.keyword) args.push("--keyword", params.keyword);
    if (params.status) args.push("--status", params.status);
    if (params.page) args.push("--page", String(params.page));
    if (params.pageSize) args.push("--page-size", String(params.pageSize));
    return this.run(args, TaskSearchResponseSchema);
  }

  async taskStatus(jobId: string, agentId?: string): Promise<TaskStatus> {
    const args = ["agent", "status", jobId];
    if (agentId) args.push("--agent-id", agentId);
    return this.run(args, TaskStatusSchema);
  }

  async taskDeliverableList(jobId: string, role: "user" | "asp" = "user"): Promise<Deliverable[]> {
    return this.run(["agent", "task-deliverable-list", "--job-id", jobId, "--role", role], DeliverableListResponseSchema);
  }

  // --- Canary / task publishing (Assay acting as User Agent / buyer) ---------
  //
  // NOTE ON IDENTITY: verified against the live `onchainos` binary (v4.2.4)
  // installed from OKX's own release — `create-task`, `draft create`,
  // `draft publish`, `complete`, and `reject` do NOT take an `--agent-id`
  // flag at all; the caller's own agent identity is resolved from the active
  // wallet session, not passed explicitly. This corrects an earlier
  // assumption (drawn from the okx-ai skill docs' conversational-flow framing,
  // where a "next-action playbook" fills params invisibly) that these
  // commands accepted a caller `--agent-id`. `--agent-id` only appears on the
  // *query* commands below (get-agents, service-list, feedback-list,
  // asp-match, task-search, status), where it targets or scopes the query.

  async createTask(params: {
    description: string;
    budget: string;
    maxBudget: string;
    currency: "USDT" | "USDG";
    title: string;
    descriptionSummary: string;
    provider?: string;
    visibility?: 0 | 1;
    serviceId?: string;
    serviceParams?: string;
    paymentMode?: "escrow" | "x402";
  }): Promise<CreateTaskResponse> {
    const args = [
      "agent",
      "create-task",
      "--description",
      params.description,
      "--budget",
      params.budget,
      "--max-budget",
      params.maxBudget,
      "--currency",
      params.currency,
      "--title",
      params.title,
      "--description-summary",
      params.descriptionSummary
    ];
    if (params.provider) args.push("--provider", params.provider);
    if (params.visibility !== undefined) args.push("--visibility", String(params.visibility));
    if (params.serviceId) args.push("--service-id", params.serviceId);
    if (params.serviceParams) args.push("--service-params", params.serviceParams);
    if (params.paymentMode) args.push("--payment-mode", params.paymentMode);
    return this.run(args, CreateTaskResponseSchema);
  }

  async draftCreate(params: {
    title: string;
    description: string;
    descriptionSummary: string;
    provider?: string;
    visibility?: 0 | 1;
    serviceId?: string;
    budget?: string;
    maxBudget?: string;
    currency?: "USDT" | "USDG";
  }): Promise<DraftResponse> {
    const args = [
      "agent",
      "draft",
      "create",
      "--title",
      params.title,
      "--description",
      params.description,
      "--description-summary",
      params.descriptionSummary
    ];
    if (params.provider) args.push("--provider", params.provider);
    if (params.visibility !== undefined) args.push("--visibility", String(params.visibility));
    if (params.serviceId) args.push("--service-id", params.serviceId);
    if (params.budget) args.push("--budget", params.budget);
    if (params.maxBudget) args.push("--max-budget", params.maxBudget);
    if (params.currency) args.push("--currency", params.currency);
    return this.run(args, DraftResponseSchema);
  }

  async draftPublish(jobId: string): Promise<CreateTaskResponse> {
    return this.run(["agent", "draft", "publish", jobId], CreateTaskResponseSchema);
  }

  async complete(jobId: string): Promise<void> {
    await this.run(["agent", "complete", jobId], AckResponseSchema);
  }

  async reject(jobId: string, reason: string): Promise<void> {
    await this.run(["agent", "reject", jobId, "--reason", reason], AckResponseSchema);
  }

  async feedbackSubmit(params: {
    rateeAgentId: string;
    raterAgentId: string;
    /** Star rating 0.00-5.00 (step 0.01) — the live CLI's own unit, NOT a 0-100 raw score. */
    score0to5: number;
    jobId: string;
    description?: string;
  }): Promise<void> {
    const args = [
      "agent",
      "feedback-submit",
      "--agent-id",
      params.rateeAgentId,
      "--creator-id",
      params.raterAgentId,
      "--score",
      params.score0to5.toFixed(2),
      "--task-id",
      params.jobId
    ];
    if (params.description) args.push("--description", params.description);
    await this.run(args, AckResponseSchema);
  }

  // --- Internals --------------------------------------------------------------

  private run<S extends z.ZodTypeAny>(args: string[], schema: S): Promise<z.infer<S>> {
    return this.exec(args).then((raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (cause) {
        throw new OnchainosParseError(args, raw, cause);
      }

      // Every onchainos command wraps its output as {ok:true, data} or
      // {ok:false, error} — confirmed against the live binary, not documented
      // in the skill docs. Unwrap `data` before validating against the
      // per-command schema below. A response that doesn't match this envelope
      // at all falls back to validating the raw payload directly, defensively,
      // in case some command doesn't use it.
      let payload: unknown = parsed;
      const envelope = EnvelopeSchema.safeParse(parsed);
      if (envelope.success) {
        if (!envelope.data.ok) {
          throw new OnchainosBusinessError(args, envelope.data.code, envelope.data.error);
        }
        payload = envelope.data.data;
      }

      const result = schema.safeParse(payload);
      if (!result.success) {
        throw new OnchainosSchemaError(args, result.error.message);
      }
      return result.data;
    });
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.config.bin, args, { timeout: this.config.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const nodeErr = err as NodeJS.ErrnoException;
          if (nodeErr.code === "ENOENT") {
            return reject(new OnchainosNotInstalledError(this.config.bin));
          }
          return reject(new OnchainosExecError(args, typeof err.code === "number" ? err.code : null, stderr || err.message));
        }
        resolve(stdout);
      });
    });
  }
}
