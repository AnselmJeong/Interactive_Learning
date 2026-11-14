import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeSubscriptionClient,
  CodexSubscriptionClient,
  type CliRunner,
  codexKnownModels,
  parseClaudeStreamResult,
  renderConversation,
} from "./subscription-cli-client";

const fakeBinDir = mkdtempSync(join(tmpdir(), "learnie-cli-test-"));
const fakeClaude = join(fakeBinDir, "claude");
const fakeCodex = join(fakeBinDir, "codex");
for (const file of [fakeClaude, fakeCodex]) {
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}
process.env.LEARNIE_CLAUDE_PATH = fakeClaude;
process.env.LEARNIE_CODEX_PATH = fakeCodex;

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function claudeStream(result: Record<string, unknown>) {
  return [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, ...result }),
  ].join("\n");
}

describe("ClaudeSubscriptionClient", () => {
  test("runs claude without tools, passes system prompt, strips API keys", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    const calls: Parameters<CliRunner>[0][] = [];
    const runner: CliRunner = async (input) => {
      calls.push(input);
      return { stdout: claudeStream({ result: "안녕하세요" }), stderr: "", code: 0 };
    };
    const client = new ClaudeSubscriptionClient("sonnet", runner);
    const text = await client.chatText({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
      thinking: "disabled",
    });
    expect(text).toBe("안녕하세요");
    const call = calls[0]!;
    expect(call.binary).toBe(fakeClaude);
    expect(call.args).toContain("-p");
    expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("sonnet");
    expect(call.args[call.args.indexOf("--system-prompt") + 1]).toBe("Be brief.");
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.env.MAX_THINKING_TOKENS).toBe("0");
    const message = JSON.parse(call.stdin.trim());
    expect(message.message.content.at(-1)).toEqual({ type: "text", text: "Hi" });
  });

  test("default model omits --model and images become content blocks", async () => {
    let args: string[] = [];
    let stdin = "";
    const client = new ClaudeSubscriptionClient("default", async (input) => {
      args = input.args;
      stdin = input.stdin;
      return { stdout: claudeStream({ result: "a chart" }), stderr: "", code: 0 };
    });
    await client.describeImage({ image: { mimeType: "image/png", dataBase64: "AAAA" }, prompt: "Explain" });
    expect(args).not.toContain("--model");
    const content = JSON.parse(stdin.trim()).message.content;
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  });

  test("login failures become auth errors with a login hint", () => {
    expect(() => parseClaudeStreamResult({
      stdout: claudeStream({ is_error: true, result: "Not logged in · Please run /login" }),
      stderr: "",
      code: 1,
    }, "sonnet")).toThrow(/로그인/);
  });

  test("chatJson parses JSON from the reply", async () => {
    const client = new ClaudeSubscriptionClient("haiku", async () => ({ stdout: claudeStream({ result: "```json\n{\"ok\":true}\n```" }), stderr: "", code: 0 }));
    expect(await client.chatJson({ messages: [{ role: "user", content: "json please" }] })).toEqual({ ok: true });
  });

  test("lists alias models when logged in", async () => {
    const models = await new ClaudeSubscriptionClient("", async () => ({ stdout: '{"loggedIn":true}', stderr: "", code: 0 })).listModels();
    expect(models.map((model) => model.id)).toEqual(["default", "opus", "sonnet", "haiku"]);
  });

  test("model listing fails fast when not logged in", async () => {
    const client = new ClaudeSubscriptionClient("", async () => ({ stdout: '{"loggedIn":false}', stderr: "", code: 1 }));
    await expect(client.listModels()).rejects.toThrow(/\/login/);
  });
});

describe("CodexSubscriptionClient", () => {
  test("runs codex exec read-only and reads the last message file", async () => {
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    let call: Parameters<CliRunner>[0] | undefined;
    const client = new CodexSubscriptionClient("gpt-5.5", async (input) => {
      call = input;
      const output = input.args[input.args.indexOf("--output-last-message") + 1]!;
      writeFileSync(output, "codex reply\n");
      return { stdout: "", stderr: "", code: 0 };
    });
    const text = await client.chatText({
      messages: [
        { role: "system", content: "Tutor rules" },
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2" },
      ],
    });
    expect(text).toBe("codex reply");
    expect(call!.args.slice(0, 2)).toEqual(["exec", "--skip-git-repo-check"]);
    expect(call!.args[call!.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(call!.args[call!.args.indexOf("--model") + 1]).toBe("gpt-5.5");
    expect(call!.env.OPENAI_API_KEY).toBeUndefined();
    expect(call!.stdin).toContain("<instructions>\nTutor rules\n</instructions>");
    expect(call!.stdin).toContain("<assistant>\nA1\n</assistant>");
  });

  test("attaches images as files", async () => {
    let imageArg = "";
    const client = new CodexSubscriptionClient("default", async (input) => {
      imageArg = input.args.find((arg) => arg.startsWith("--image="))!;
      expect(readFileSync(imageArg.slice("--image=".length)).toString("base64")).toBe("AAAA");
      writeFileSync(input.args[input.args.indexOf("--output-last-message") + 1]!, "figure");
      return { stdout: "", stderr: "", code: 0 };
    });
    expect(await client.describeImage({ image: { mimeType: "image/jpeg", dataBase64: "AAAA" }, prompt: "Explain" })).toBe("figure");
    expect(imageArg).toEndWith(".jpg");
  });

  test("non-zero exit without output surfaces the CLI error", async () => {
    const client = new CodexSubscriptionClient("default", async () => ({ stdout: "", stderr: "Error: 401 Unauthorized", code: 1 }));
    await expect(client.chatText({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/codex login/);
  });

  test("model listing fails fast when codex is not logged in", async () => {
    const client = new CodexSubscriptionClient("", async () => ({ stdout: "", stderr: "Not logged in", code: 1 }));
    await expect(client.listModels()).rejects.toThrow(/codex login/);
  });

  test("reads known models from CODEX_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "learnie-codex-home-"));
    try {
      writeFileSync(join(home, "config.toml"), 'model = "gpt-5.5"\n');
      writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-6-sol" }, { slug: "hidden", visibility: "hide" }] }));
      expect(codexKnownModels(home)).toEqual(["gpt-5.5", "gpt-6-sol"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("renderConversation keeps single user turns verbatim", () => {
  expect(renderConversation([{ role: "user", content: "hello" }])).toBe("hello");
});
