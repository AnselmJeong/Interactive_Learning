import { afterEach, describe, expect, test } from "bun:test";
import { OpenAICompatibleClient } from "./openai-compatible-client";

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
