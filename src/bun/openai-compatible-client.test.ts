import { afterEach, describe, expect, test } from "bun:test";
import { OpenAICompatibleClient } from "./openai-compatible-client";
import { CONSERVATIVE_OUTPUT_TOKENS, DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS } from "./output-token-budget";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI-compatible thinking controls", () => {
  test("allows local Ollama model listing without an API key", async () => {
    let authorization: string | null = "unexpected";
    globalThis.fetch = (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: [{ id: "llama3.2" }] }), { status: 200 });
    }) as typeof fetch;

    const client = new OpenAICompatibleClient({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "llama3.2",
      providerName: "Ollama",
    });

    const models = await client.listModels();

    expect(models[0]?.id).toBe("llama3.2");
    expect(authorization).toBeNull();
  });

  test("allows local Ollama chat without an API key", async () => {
    let authorization: string | null = "unexpected";
    globalThis.fetch = (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "local response" } }],
      }), { status: 200 });
    }) as typeof fetch;

    const client = new OpenAICompatibleClient({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      model: "llama3.2",
      providerName: "Ollama",
    });

    const text = await client.chatText({ messages: [{ role: "user", content: "hi" }] });

    expect(text).toBe("local response");
    expect(authorization).toBeNull();
  });

  test("uses Ollama's OpenAI-compatible reasoning_effort=none for disabled thinking", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "좋아요." } }],
      }), { status: 200 });
    }) as typeof fetch;

    const client = new OpenAICompatibleClient({
      baseUrl: "https://ollama.com/v1",
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      providerName: "Ollama",
    });

    const text = await client.chatText({
      messages: [{ role: "user", content: "짧게 한마디" }],
      thinking: "disabled",
    });

    expect(text).toBe("좋아요.");
    expect(url).toBe("https://ollama.com/v1/chat/completions");
    expect(body.reasoning_effort).toBe("none");
    expect(body).not.toHaveProperty("think");
    expect(body).not.toHaveProperty("thinking");
  });

  test.each(["deepseek-v4.1-flash:1017", "deepseek-v4:latest", "deepseek-v4"])("disables thinking for Ollama DeepSeek V4 variant %s", async (model) => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
      }), { status: 200 });
    }) as typeof fetch;

    const client = new OpenAICompatibleClient({ baseUrl: "https://ollama.com/v1", apiKey: "test-key", model, providerName: "Ollama Cloud" });
    await client.chatJson({ messages: [{ role: "user", content: "{}" }], thinking: "disabled" });

    expect(body.reasoning_effort).toBe("none");
  });

  test("does not send a thinking toggle to unrelated DeepSeek-named models", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{}" } }],
      }), { status: 200 });
    }) as typeof fetch;

    const client = new OpenAICompatibleClient({ baseUrl: "https://ollama.com/v1", apiKey: "test-key", model: "deepseek-v40", providerName: "Ollama Cloud" });
    await client.chatJson({ messages: [{ role: "user", content: "{}" }], thinking: "disabled" });

    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("keeps DeepSeek-style thinking objects for non-Ollama DeepSeek endpoints", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "좋아요." } }],
      }), { status: 200 });
    }) as typeof fetch;

    const client = new OpenAICompatibleClient({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      providerName: "DeepSeek",
    });

    await client.chatText({
      messages: [{ role: "user", content: "짧게 한마디" }],
      thinking: "disabled",
    });

    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("think");
  });
});

describe("OpenAI-compatible output token budget", () => {
  const ollama = () => new OpenAICompatibleClient({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    model: "deepseek-v4.1-flash:1017",
    providerName: "Ollama",
  });

  test("never sends less than the output token floor, even when a call site asks for less", async () => {
    const budgets: number[] = [];
    globalThis.fetch = (async (_input, init) => {
      budgets.push(JSON.parse(String(init?.body)).max_tokens);
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "답변" } }] }), { status: 200 });
    }) as typeof fetch;

    await ollama().chatText({ messages: [{ role: "user", content: "hi" }], maxTokens: 3200 });
    await ollama().chatText({ messages: [{ role: "user", content: "hi" }] });

    expect(budgets).toEqual([MIN_OUTPUT_TOKENS, DEFAULT_OUTPUT_TOKENS]);
  });

  test("retries with a doubled budget when the model stops with finish_reason=length", async () => {
    const budgets: number[] = [];
    globalThis.fetch = (async (_input, init) => {
      budgets.push(JSON.parse(String(init?.body)).max_tokens);
      const finished = budgets.length > 1;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: finished ? "stop" : "length", message: { content: finished ? "완성된 답변" : "잘린 답" } }],
      }), { status: 200 });
    }) as typeof fetch;

    const text = await ollama().chatText({ messages: [{ role: "user", content: "hi" }] });

    expect(text).toBe("완성된 답변");
    expect(budgets).toEqual([MIN_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS * 2]);
  });

  test("gives up with a clear error once the ceiling is reached", async () => {
    const budgets: number[] = [];
    globalThis.fetch = (async (_input, init) => {
      budgets.push(JSON.parse(String(init?.body)).max_tokens);
      return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "..." } }] }), { status: 200 });
    }) as typeof fetch;

    await expect(ollama().chatText({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("finish_reason=length");
    expect(budgets.at(-1)).toBe(MAX_OUTPUT_TOKENS);
  });

  test("falls back to a conservative budget when the provider rejects a large max_tokens", async () => {
    const budgets: number[] = [];
    globalThis.fetch = (async (_input, init) => {
      const budget = JSON.parse(String(init?.body)).max_tokens;
      budgets.push(budget);
      if (budget > CONSERVATIVE_OUTPUT_TOKENS) {
        return new Response(JSON.stringify({ error: { message: "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;

    const client = new OpenAICompatibleClient({ baseUrl: "https://api.example.com/v1", apiKey: "key", model: "small-model", providerName: "OpenAI-compatible" });
    expect(await client.chatText({ messages: [{ role: "user", content: "hi" }] })).toBe("ok");
    expect(budgets).toEqual([MIN_OUTPUT_TOKENS, CONSERVATIVE_OUTPUT_TOKENS]);
  });
});
