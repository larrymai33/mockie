import type { InterviewContext, InterviewProvider, InterviewerDecision, Scorecard } from "@mockie/core";
import {
  buildInterviewPrompt,
  buildScorecardPrompt,
  createFallbackScorecard,
  parseInterviewerDecision,
  parseScorecard
} from "@mockie/core";

export interface LiteLLMProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type Prompt = { instructions: string; input: string };

export function extractResponseText(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("LiteLLM response did not contain text");
  const response = value as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }>;
  };
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if ((content.type === "output_text" || content.type === undefined) && typeof content.text === "string" && content.text.trim()) {
        return content.text;
      }
    }
  }
  throw new Error("LiteLLM response did not contain text");
}

export class LiteLLMProvider implements InterviewProvider {
  readonly mode = "online" as const;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #model: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: LiteLLMProviderOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async respond(context: InterviewContext): Promise<InterviewerDecision> {
    const text = await this.#request(buildInterviewPrompt(context));
    return parseInterviewerDecision(text);
  }

  async score(context: InterviewContext): Promise<Scorecard> {
    const text = await this.#request(buildScorecardPrompt(context));
    return parseScorecard(text) ?? createFallbackScorecard(context);
  }

  async #request(prompt: Prompt): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
    const response = await this.#fetch(`${this.#baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
      body: JSON.stringify({
        model: this.#model,
        instructions: prompt.instructions,
        input: [{ role: "user", content: prompt.input }]
      })
    });
    if (!response.ok) throw new Error(`LiteLLM request failed (${response.status})`);
    const body = (await response.json()) as unknown;
    return extractResponseText(body);
  }
}
