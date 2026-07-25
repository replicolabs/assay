/**
 * Pluggable LLM interface so acceptance-criteria generation / skill
 * classification isn't hard-wired to one provider. Default implementation
 * is Anthropic's Claude API (needs ANTHROPIC_API_KEY — see README §Setup).
 */
export interface LLMClient {
  /** A single free-form completion call: system + user prompt in, raw text out. */
  complete(params: { system: string; prompt: string; maxTokens?: number }): Promise<string>;
}

export class AnthropicLLMClient implements LLMClient {
  private client: import("@anthropic-ai/sdk").default | undefined;

  // Both current callers (buildTaskSpec's structured JSON extraction,
  // gateTaskScope's binary classification) are narrow, well-specified tasks
  // — not open-ended reasoning. Same cost lesson as the okx-a2a daemon
  // (vendor/claude-config/settings.json): default to the cheapest model
  // that's actually sufficient, not the strongest available. Both run
  // automatically now (a2aDeliverer.ts, the A2A responder's scope gate), not
  // just on user-triggered calls, so the per-call cost compounds.
  constructor(private readonly apiKey: string = process.env.ANTHROPIC_API_KEY ?? "", private readonly model: string = "claude-haiku-4-5-20251001") {}

  private async getClient() {
    if (!this.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set — see README §Setup");
    }
    if (!this.client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.client = new Anthropic({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async complete(params: { system: string; prompt: string; maxTokens?: number }): Promise<string> {
    const client = await this.getClient();
    const response = await client.messages.create({
      model: this.model,
      max_tokens: params.maxTokens ?? 1024,
      system: params.system,
      messages: [{ role: "user", content: params.prompt }]
    });
    const textBlock = response.content.find((b): b is { type: "text"; text: string } => b.type === "text");
    return textBlock?.text ?? "";
  }
}

/** Deterministic no-LLM fallback for tests/dev without an API key configured. */
export class NullLLMClient implements LLMClient {
  async complete(): Promise<string> {
    throw new Error("No LLM configured (ANTHROPIC_API_KEY unset) — see README §Setup");
  }
}
