import { z } from "zod";

/**
 * Field mappings below are cross-checked against two sources, in order of
 * trust: (1) live responses from the real `onchainos` v4.2.4 binary against
 * OKX's actual backend (captured during setup — see README §OKX.AI
 * integration for the specific commands verified this way), (2) OKX's
 * published `okx-ai` skill docs (`references/task-core.md`,
 * `task-cli-reference.md`) for anything not yet live-verified. Live
 * verification caught real drift from the docs alone — see the envelope
 * wrapper below and the service-list nesting.
 */

/** Every onchainos command wraps its output as `{ok:true, data}` or `{ok:false, error}` — confirmed live, not documented anywhere in the skill docs. */
export const EnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string(), code: z.union([z.string(), z.number()]).optional() })
]);

export const TASK_STATUS_BY_CODE = {
  "-1": "draft",
  "0": "created",
  "1": "accepted",
  "2": "submitted",
  "3": "rejected",
  "4": "disputed",
  "5": "admin_stopped",
  "6": "completed",
  "7": "close",
  "8": "expired",
  "9": "failed"
} as const;

export type TaskStatusCode = keyof typeof TASK_STATUS_BY_CODE;
export type TaskStatusName = (typeof TASK_STATUS_BY_CODE)[TaskStatusCode];

/** Terminal statuses only — non-terminal = 0/1/2/3/4. */
export const TERMINAL_TASK_STATUS_CODES: ReadonlySet<TaskStatusCode> = new Set(["5", "6", "7", "8", "9"]);

export const VISIBILITY = { PUBLIC: 0, PRIVATE: 1 } as const;
export const PAYMENT_MODE = { UNSET: 0, ESCROW: 1, X402: 3 } as const;

// --- `agent search` ---------------------------------------------------------
// Registry keyword/filter search over the identity registry (NOT the task pool).
// `cells` (live-verified) is {label,value}[] — a pre-rendered display table,
// not the flat string array the skill docs' prose implied. `services[]` is
// the real per-agent service list; there's no flat `topService` field, it's
// derived downstream (registry.ts) from `services[0]` or the "Top service" cell.
export const AgentSearchServiceSchema = z
  .object({
    serviceId: z.union([z.string(), z.number()]).transform(String),
    serviceName: z.string(),
    serviceType: z.enum(["a2a", "a2mcp", "A2A", "A2MCP"]).transform((v) => v.toLowerCase() as "a2a" | "a2mcp"),
    feeAmount: z.union([z.string(), z.number()]).nullable().optional(),
    feeToken: z.string().nullable().optional(),
    endpoint: z.string().nullable().optional(),
    serviceDescription: z.string().nullable().optional()
  })
  .passthrough();

export const AgentSearchRowSchema = z
  .object({
    agentId: z.union([z.string(), z.number()]).transform(String),
    name: z.string(),
    feedbackRate: z.number().nullable().optional(),
    serviceMinPrice: z.union([z.string(), z.number()]).nullable().optional(),
    services: z.array(AgentSearchServiceSchema).optional(),
    categoryCode: z.array(z.string()).optional(),
    categoryName: z.array(z.string()).optional(),
    cells: z.array(z.object({ label: z.string(), value: z.string() })).optional()
  })
  .passthrough();

export const AgentSearchResponseSchema = z
  .object({
    list: z.array(AgentSearchRowSchema),
    total: z.number()
  })
  .passthrough();
export type AgentSearchResponse = z.infer<typeof AgentSearchResponseSchema>;

// --- `agent get-agents --agent-ids` -----------------------------------------
// `role`/`status` are live-verified as numeric codes with separate *Label
// string fields (roleLabel/statusLabel) carrying the human-readable value —
// accept both shapes since the raw codes' meaning isn't documented anywhere
// we've verified, only the labels are self-describing.
export const AgentDetailSchema = z
  .object({
    agentId: z.union([z.string(), z.number()]).transform(String),
    name: z.string(),
    role: z.union([z.string(), z.number()]).optional(),
    roleLabel: z.string().optional(),
    status: z.union([z.string(), z.number()]).optional(),
    statusLabel: z.string().optional(),
    /** 1 = online, 2 = offline — live-verified. Not documented in the skill docs. */
    onlineStatus: z.number().optional(),
    ownerAddress: z.string().optional(),
    card: z.array(z.object({ label: z.string(), value: z.string() })).optional()
  })
  .passthrough();
export type AgentDetail = z.infer<typeof AgentDetailSchema>;

// `get-agents` returns a flat top-level array — live-verified.
export const AgentDetailListSchema = z.array(AgentDetailSchema);

// --- `agent service-list --agent-id` ----------------------------------------
// Live-verified: response is NOT a bare array — it's `{agentInfo, list}`, and
// each row uses `id`/`serviceName`/`serviceDescription`/`fee`, not the
// `serviceId`/`name`/`description`/`fee` shape the skill docs' render-table
// description implied.
export const AgentServiceSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String).optional(),
    serviceName: z.string(),
    serviceType: z.enum(["a2a", "a2mcp", "A2A", "A2MCP"]).transform((v) => v.toLowerCase() as "a2a" | "a2mcp"),
    fee: z.union([z.string(), z.number()]).nullable().optional(),
    contractAddress: z.string().nullable().optional(),
    endpoint: z.string().nullable().optional(),
    serviceDescription: z.string().nullable().optional()
  })
  .passthrough()
  .transform((v) => ({
    serviceId: v.id,
    name: v.serviceName,
    serviceType: v.serviceType,
    fee: v.fee ?? null,
    endpoint: v.endpoint ?? null,
    description: v.serviceDescription ?? null
  }));
export type AgentService = z.infer<typeof AgentServiceSchema>;

// Live-verified (2026-07-15, against agent 2993 — the first time this method
// was ever actually exercised through the real client rather than ad-hoc
// parsing): `data` is an ARRAY containing one `{agentInfo, list}` object, not
// the bare object itself. Everything upstream of this schema (including the
// earlier "live-verified" comment above) had only ever been checked by
// manually indexing `data[0]` in throwaway scripts — the schema itself was
// wrong the whole time, just never exercised until now.
export const AgentServiceListResponseSchema = z
  .array(
    z
      .object({
        agentInfo: z.unknown().optional(),
        list: z.array(AgentServiceSchema)
      })
      .passthrough()
  )
  .transform((v) => v[0]?.list ?? []);

// --- `agent feedback-list --agent-id` ---------------------------------------
// CLI pre-converts wire score to 0.00-5.00 stars (docs: "already-converted 0.00-5.00 score").
export const FeedbackItemSchema = z
  .object({
    score: z.number().min(0).max(5),
    reviewerId: z.union([z.string(), z.number()]).transform(String).optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    date: z.string().optional(),
    taskHash: z.string().optional(),
    taskId: z.string().optional(),
    description: z.string().nullable().optional()
  })
  .passthrough();
// Docs: "The array is under `items` or `list` (backend inconsistent; CLI normalizes both)".
export const FeedbackListResponseSchema = z
  .object({
    items: z.array(FeedbackItemSchema).optional(),
    list: z.array(FeedbackItemSchema).optional()
  })
  .passthrough()
  .transform((v) => v.items ?? v.list ?? []);
export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

// --- `agent task-search` (task pool, not identity registry) ----------------
// Response shape given verbatim in task-cli-reference.md.
export const TaskSearchRowSchema = z
  .object({
    jobId: z.string(),
    title: z.string(),
    status: z.string(),
    clientAgentId: z.union([z.string(), z.number()]).transform(String),
    tokenAddress: z.string().optional(),
    tokenSymbol: z.string(),
    tokenAmount: z.union([z.string(), z.number()]).transform(String),
    createTime: z.union([z.string(), z.number()]).optional()
  })
  .passthrough();
export const TaskSearchResponseSchema = z
  .object({
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
    tasks: z.array(TaskSearchRowSchema)
  })
  .passthrough();
export type TaskSearchResponse = z.infer<typeof TaskSearchResponseSchema>;

// --- `agent status <jobId>` / `agent active-tasks` --------------------------
// active-tasks' per-row shape is given verbatim in docs; `status` returns the
// same task at minimum plus negotiation params, so this schema is intentionally
// a loose superset (passthrough) rather than claiming fields not documented.
export const TaskStatusSchema = z
  .object({
    jobId: z.string(),
    shortJobId: z.string().optional(),
    status: z.string(),
    statusCode: z.number().optional(),
    title: z.string().optional(),
    tokenAmount: z.union([z.string(), z.number()]).optional(),
    tokenSymbol: z.string().optional(),
    myAgentId: z.union([z.string(), z.number()]).transform(String).optional(),
    myRole: z.string().optional(),
    counterpartyAgentId: z.union([z.string(), z.number()]).transform(String).optional(),
    counterpartyRole: z.string().optional(),
    updateTime: z.union([z.string(), z.number()]).optional()
  })
  .passthrough();
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// --- `agent asp-match` -------------------------------------------------------
export const AspMatchRecommendationSchema = z
  .object({
    agentId: z.union([z.string(), z.number()]).transform(String),
    serviceId: z.union([z.string(), z.number()]).transform(String),
    serviceType: z.enum(["a2a", "a2mcp", "A2A", "A2MCP"]).transform((v) => v.toLowerCase() as "a2a" | "a2mcp"),
    feeToken: z.string().optional(),
    feeAmount: z.union([z.string(), z.number()]).optional(),
    endpoint: z.string().nullable().optional()
  })
  .passthrough();
export const AspMatchResponseSchema = z
  .object({
    recommendations: z.array(AspMatchRecommendationSchema)
  })
  .passthrough();
export type AspMatchResponse = z.infer<typeof AspMatchResponseSchema>;

// --- `agent create-task` / `agent draft publish` -----------------------------
export const CreateTaskResponseSchema = z
  .object({
    jobId: z.string(),
    status: z.string().optional(),
    txHash: z.string().optional()
  })
  .passthrough();
export type CreateTaskResponse = z.infer<typeof CreateTaskResponseSchema>;

// --- `agent draft create` ----------------------------------------------------
export const DraftResponseSchema = z
  .object({
    jobId: z.string()
  })
  .passthrough();
export type DraftResponse = z.infer<typeof DraftResponseSchema>;

// --- `agent task-deliverable-list` ------------------------------------------
export const DeliverableSchema = z
  .object({
    path: z.string(),
    originalName: z.string().optional(),
    deliverableType: z.enum(["file", "text"]),
    sizeBytes: z.number().optional(),
    savedAt: z.string().optional()
  })
  .passthrough();
export type Deliverable = z.infer<typeof DeliverableSchema>;

export const DeliverableListResponseSchema = z
  .object({
    deliverables: z.array(DeliverableSchema).optional(),
    results: z.array(DeliverableSchema).optional()
  })
  .passthrough()
  .transform((v) => v.deliverables ?? v.results ?? []);

// --- generic ack (feedback-submit, complete, reject, deliver, ...) ----------
export const AckResponseSchema = z
  .object({
    success: z.boolean().optional(),
    txHash: z.string().optional()
  })
  .passthrough();

// --- `agent x402-check` ------------------------------------------------------
// Live-verified: acceptsJson is a JSON *string* (needs re-parsing), not a
// nested object — the CLI passes it straight through as the raw HTTP 402
// body's `accepts` array, serialized.
export const X402CheckResponseSchema = z
  .object({
    valid: z.boolean(),
    acceptsJson: z.string(),
    amountHuman: z.number().optional(),
    amountMinimal: z.string().optional(),
    asset: z.string().optional(),
    payTo: z.string().optional(),
    tokenSymbol: z.string().optional()
  })
  .passthrough();
export type X402CheckResponse = z.infer<typeof X402CheckResponseSchema>;

// --- `agent task-402-pay` ----------------------------------------------------
// Live-verified: the deliverable comes back inline as `replayBody` in the
// same response that signs and broadcasts payment — x402 settles and
// delivers atomically, unlike escrow's create -> accept -> submit -> complete
// lifecycle. `deliverableSavedPath` confirms the CLI also persisted it
// locally, same as the escrow path's task-deliverable-list mechanism.
export const Task402PayResponseSchema = z
  .object({
    deliverableSavedPath: z.string().optional(),
    replayBody: z.unknown().optional()
  })
  .passthrough();
export type Task402PayResponse = z.infer<typeof Task402PayResponseSchema>;
