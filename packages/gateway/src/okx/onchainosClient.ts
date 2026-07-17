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
  ActiveTasksResponseSchema,
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
  HeartbeatResponseSchema,
  Task402PayResponseSchema,
  TaskSearchResponseSchema,
  TaskStatusSchema,
  X402CheckResponseSchema,
  type ActiveTasksResponse,
  type AgentDetail,
  type AgentSearchResponse,
  type AgentService,
  type AspMatchResponse,
  type CreateTaskResponse,
  type Deliverable,
  type DraftResponse,
  type FeedbackItem,
  type Task402PayResponse,
  type TaskSearchResponse,
  type TaskStatus,
  type X402CheckResponse
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

  /**
   * Reports online status. Live-verified: our own ASP identity (5586) went
   * offline (onlineStatus:2) with no code anywhere calling this — OKX's own
   * docs describe it as "auto-scheduled by runtime", but that only applies to
   * whatever hosts an interactive CLI session, not a stateless child_process
   * wrapper like this one. Nothing else schedules it for us. See
   * heartbeatLoop.ts for the periodic caller.
   */
  async heartbeat(chainIndex: number): Promise<void> {
    await this.run(["agent", "heartbeat", "--chain-index", String(chainIndex)], HeartbeatResponseSchema);
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

  /** Non-terminal tasks across all agents under the active account, optionally role-filtered. */
  async activeTasks(opts: { role?: "user" | "asp" | "evaluator"; includeTerminal?: boolean } = {}): Promise<ActiveTasksResponse> {
    const args = ["agent", "active-tasks"];
    if (opts.role) args.push("--role", opts.role);
    if (opts.includeTerminal) args.push("--include-terminal");
    return this.run(args, ActiveTasksResponseSchema);
  }

  /**
   * ASP cold-start: sends the fixed, non-customizable A2A negotiation opener
   * to the User Agent of a designated task (`okx-a2a session create` +
   * `okx-a2a xmtp-send` in one call). This is the ONLY automated response
   * this client sends on the ASP side — `apply` is deliberately NOT wrapped
   * here, since OKX's own documented protocol (okx-ai skill,
   * task-asp-accept.md) states apply is system-event-triggered only
   * ("JobAspSelected" playbook) and manual/automated invocation from the
   * cold-start path is an explicitly documented anti-pattern (risks state
   * machine corruption / escrow issues).
   */
  async contactUser(jobId: string, agentId: string): Promise<void> {
    await this.run(["agent", "contact-user", jobId, "--agent-id", agentId], AckResponseSchema);
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
    paymentMode?: "escrow" | "x402";
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
    if (params.paymentMode) args.push("--payment-mode", params.paymentMode);
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

  // --- x402 (Assay acting as payer against an A2MCP provider's endpoint) -----

  async x402Check(endpoint: string, opts: { agentId?: string; body?: string } = {}): Promise<X402CheckResponse> {
    const args = ["agent", "x402-check", "--endpoint", endpoint];
    if (opts.agentId) args.push("--agent-id", opts.agentId);
    if (opts.body) args.push("--body", opts.body);
    return this.run(args, X402CheckResponseSchema);
  }

  async task402Pay(
    jobId: string,
    params: {
      providerAgentId: string;
      /** Raw `accepts` array JSON string, verbatim from x402Check's `acceptsJson`. */
      accepts: string;
      endpoint: string;
      tokenSymbol: string;
      /** Human-readable amount (e.g. "0.25"), NOT minimal units — live-verified. */
      tokenAmount: string;
      from?: string;
    }
  ): Promise<Task402PayResponse> {
    const args = [
      "agent",
      "task-402-pay",
      jobId,
      "--provider-agent-id",
      params.providerAgentId,
      "--accepts",
      params.accepts,
      "--endpoint",
      params.endpoint,
      "--token-symbol",
      params.tokenSymbol,
      "--token-amount",
      params.tokenAmount
    ];
    if (params.from) args.push("--from", params.from);
    return this.run(args, Task402PayResponseSchema);
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
        // Live-verified: some commands (create-task, draft create, draft
        // publish) non-deterministically print human-readable console text
        // ("✓ Draft saved (jobId: 0x...)") instead of JSON — the *same*
        // command with identical arguments has been observed returning both
        // formats across different runs, so this isn't a per-command fixed
        // quirk to special-case, it's a real formatting inconsistency in the
        // binary itself. Falls back to regex-extracting jobId/txHash/status
        // from the pretty text rather than failing a call that actually
        // succeeded server-side (this is often caught *after* a real
        // on-chain broadcast already happened).
        const fallback = extractPrettyTextFields(raw);
        if (!fallback) {
          throw new OnchainosParseError(args, raw, cause);
        }
        parsed = { ok: true, data: fallback };
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
          return reject(new OnchainosExecError(args, typeof err.code === "number" ? err.code : null, stderr || err.message, stdout));
        }
        resolve(stdout);
      });
    });
  }
}

/**
 * Extracts jobId/txHash/status from human-readable console output like
 * "✓ Draft saved (jobId: 0x...)" or the multi-line create-task confirmation
 * block. Returns null (not a fallback match) if no jobId pattern is found at
 * all — callers treat that as a genuine parse failure, not this quirk.
 */
function extractPrettyTextFields(raw: string): { jobId: string; txHash?: string; status?: string } | null {
  const jobId = raw.match(/jobId:\s*(0x[a-fA-F0-9]+)/)?.[1];
  if (!jobId) return null;
  const txHash = raw.match(/txHash:\s*(0x[a-fA-F0-9]+)/)?.[1];
  const status = raw.match(/^Task status:\s*(\S+)/m)?.[1];
  return { jobId, ...(txHash ? { txHash } : {}), ...(status ? { status } : {}) };
}
