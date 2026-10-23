import { describe, expect, it, vi } from "vitest";
import { LiteLLMProvider, extractResponseText } from "./litellm.js";

const context = {
  problem: {
    id: "two-sum",
    title: "Two Sum",
    difficulty: "easy" as const,
    description: "Return two indexes.",
    constraints: ["One answer exists"],
    examples: [],
    starterCode: { python: "def two_sum(): pass", javascript: "function twoSum() {}" }
  },
  language: "python" as const,
  code: "def two_sum():\n    pass",
  transcript: [],
  runs: [],
  trigger: "candidate_message" as const,
  candidateMessage: "Can the input be empty?",
  elapsedMs: 60_000,
  durationMs: 2_700_000
};

describe("LiteLLMProvider", () => {
  it("uses Responses with a list input and never sends rejected ChatGPT fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: '{"action":"speak","message":"What trade-off are you considering?"}'
                }
              ]
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const provider = new LiteLLMProvider({
      baseUrl: "http://litellm:4000",
      apiKey: "sk-local",
      model: "chatgpt/gpt-5.4",
      fetchImpl
    });

    await expect(provider.respond(context)).resolves.toEqual({
      action: "speak",
      message: "What trade-off are you considering?"
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(url).toBe("http://litellm:4000/v1/responses");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-local" });
    expect(Object.keys(payload).sort()).toEqual(["input", "instructions", "model"]);
    expect(payload.input).toBeInstanceOf(Array);
    expect(payload).not.toHaveProperty("max_tokens");
    expect(payload).not.toHaveProperty("max_output_tokens");
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(payload).not.toHaveProperty("metadata");
  });

  it("surfaces a useful provider error without leaking response HTML", async () => {
    const provider = new LiteLLMProvider({
      baseUrl: "http://litellm:4000/",
      model: "chatgpt/gpt-5.4",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("<html>gateway exploded with a very long secret</html>", { status: 502 })
      )
    });

    await expect(provider.respond(context)).rejects.toThrow("LiteLLM request failed (502)");
  });

  it("aborts a provider request that does not finish before its deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    );
    const provider = new LiteLLMProvider({
      baseUrl: "http://litellm:4000",
      model: "chatgpt/gpt-5.4",
      requestTimeoutMs: 20,
      fetchImpl
    });

    await expect(provider.respond(context)).rejects.toThrow();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
describe("extractResponseText", () => {
  it("reads standard Responses output text", () => {
    expect(
      extractResponseText({
        output: [{ content: [{ type: "output_text", text: "hello" }] }]
      })
    ).toBe("hello");
  });

  it("rejects a response with no assistant text", () => {
    expect(() => extractResponseText({ output: [] })).toThrow("did not contain text");
  });
});
