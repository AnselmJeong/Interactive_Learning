import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { ProviderModel } from "../shared/settings-types";
import { type AiChatClient, type ChatMessage, type ChatParams, type ImagePart, parseJsonFromText } from "./openai-compatible-client";
import { ProviderError, providerConfigurationError, providerTimeoutError } from "./provider-error";

/**
 * Subscription-backed providers.
 *
 * Instead of calling the OpenAI / Anthropic HTTP APIs with an API key, these clients drive the
 * locally installed, already logged-in agent CLIs:
 *   - "openai"    → Codex CLI (`codex login` with a ChatGPT Plus/Pro/Team subscription)
 *   - "anthropic" → Claude Code CLI (`claude` → /login with a Claude Pro/Max subscription)
 *
 * The CLIs keep their own OAuth credentials, so Learnie never stores a key for these providers.
 */
export type SubscriptionProviderId = "openai" | "anthropic";

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProviderId[] = ["openai", "anthropic"];

export function isSubscriptionProvider(provider: string): provider is SubscriptionProviderId {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider);
}

/** Model id meaning "let the CLI use its own configured default model". */
export const CLI_DEFAULT_MODEL = "default";

type CliSpec = {
  label: string;
  binary: string;
  envOverride: string;
  loginHint: string;
  /** Env vars removed from the child process so the CLI uses the subscription login, not an API key. */
  strippedEnv: string[];
};

const CLI_SPECS: Record<SubscriptionProviderId, CliSpec> = {
  openai: {
    label: "Codex",
    binary: "codex",
    envOverride: "LEARNIE_CODEX_PATH",
    loginHint: "터미널에서 `codex login`을 실행해 ChatGPT 계정으로 로그인하세요.",
    strippedEnv: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"],
  },
  anthropic: {
    label: "Claude",
    binary: "claude",
    envOverride: "LEARNIE_CLAUDE_PATH",
    loginHint: "터미널에서 `claude`를 실행한 뒤 /login으로 Claude 구독 계정에 로그인하세요.",
    strippedEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
  },
};

const CLAUDE_MODELS = [CLI_DEFAULT_MODEL, "opus", "sonnet", "haiku"];
const MIN_CLI_TIMEOUT_MS = 60_000;
const DEFAULT_CLI_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// CLI discovery
// ---------------------------------------------------------------------------

let cachedSearchPath: string | null = null;
const resolvedBinaries = new Map<SubscriptionProviderId, string | null>();

/**
 * GUI apps on macOS start with a minimal PATH, so `codex` / `claude` (and the `node` they may need)
 * are often not visible. Build a PATH from the login shell plus common install locations.
 */
export function cliSearchPath() {
  if (cachedSearchPath !== null) return cachedSearchPath;
  const home = homedir();
  const parts: string[] = [];
  const push = (value: string | undefined) => {
    for (const entry of (value || "").split(delimiter)) {
      if (entry && !parts.includes(entry)) parts.push(entry);
    }
  };
  push(process.env.PATH);
  if (process.platform !== "win32") push(loginShellPath());
  for (const dir of [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]) push(dir);
  for (const dir of nvmBinDirs(home)) push(dir);
  cachedSearchPath = parts.join(delimiter);
  return cachedSearchPath;
}

function loginShellPath() {
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  try {
    const result = spawnSync(shell, ["-ilc", "printf '__LEARNIE_PATH__%s' \"$PATH\""], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /__LEARNIE_PATH__(.*)$/s.exec(result.stdout || "");
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

function nvmBinDirs(home: string) {
  const root = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root).sort().reverse().map((version) => join(root, version, "bin"));
  } catch {
    return [];
  }
}

export function resolveCliBinary(provider: SubscriptionProviderId): string | null {
  const spec = CLI_SPECS[provider];
  const override = process.env[spec.envOverride]?.trim();
  if (override) return existsSync(override) ? override : null;
  if (resolvedBinaries.has(provider)) return resolvedBinaries.get(provider) ?? null;
  const names = process.platform === "win32" ? [`${spec.binary}.cmd`, `${spec.binary}.exe`, spec.binary] : [spec.binary];
  let found: string | null = null;
  for (const dir of cliSearchPath().split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found) break;
  }
  // Only cache hits, so installing the CLI while Learnie is open is picked up on the next check.
  if (found) resolvedBinaries.set(provider, found);
  return found;
}

export function subscriptionCliState(provider: SubscriptionProviderId) {
  const binary = resolveCliBinary(provider);
  return { installed: Boolean(binary), binary };
}

function cliEnv(provider: SubscriptionProviderId, binary: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const key of CLI_SPECS[provider].strippedEnv) delete env[key];
  env.PATH = [dirname(binary), cliSearchPath()].join(delimiter);
  return { ...env, ...extra };
}

async function scratchDir() {
  const base = join(tmpdir(), "learnie-cli");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "run-"));
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

type RunResult = { stdout: string; stderr: string; code: number | null };

export type CliRunner = (input: {
  binary: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}) => Promise<RunResult>;

export const runCliProcess: CliRunner = ({ binary, args, stdin, cwd, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(Object.assign(new Error("CLI timed out"), { name: "TimeoutError" }));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

export function splitSystem(messages: ChatMessage[]) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n").trim();
  const turns = messages.filter((message) => message.role !== "system");
  return { system, turns };
}

/** Render a multi-turn conversation as a single prompt, since the CLIs take one user turn per call. */
export function renderConversation(turns: ChatMessage[]) {
  if (!turns.length) return "";
  const [only] = turns;
  if (turns.length === 1 && only?.role === "user") return only.content;
  const body = turns
    .map((turn) => `<${turn.role}>\n${turn.content}\n</${turn.role}>`)
    .join("\n\n");
  return [
    "Below is the conversation so far. Reply as the assistant to the final user message.",
    "Return only the assistant's reply, without role tags.",
    "",
    "<conversation>",
    body,
    "</conversation>",
  ].join("\n");
}

function effectiveTimeout(timeoutMs?: number) {
  return Math.max(timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS, MIN_CLI_TIMEOUT_MS);
}

function tail(text: string, max = 700) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

function classifyCliFailure(provider: SubscriptionProviderId, model: string | undefined, detail: string) {
  const spec = CLI_SPECS[provider];
  const lower = detail.toLowerCase();
  const target = model && model !== CLI_DEFAULT_MODEL ? `${spec.label} model ${model}` : spec.label;
  if (/(not logged in|please run \/login|login required|unauthori[sz]ed|401|invalid api key|authentication|oauth|token (has )?expired|sign in)/.test(lower)) {
    return new ProviderError(`${target} 구독 로그인이 필요합니다. ${spec.loginHint} Details: ${detail}`, { kind: "auth", provider: spec.label, model, body: detail });
  }
  if (/(usage limit|rate limit|429|quota|limit reached|too many requests)/.test(lower)) {
    return new ProviderError(`${target} 구독 사용량 한도에 도달했습니다. 잠시 후 다시 시도하세요. Details: ${detail}`, { kind: "rate_limit", provider: spec.label, model, body: detail });
  }
  if (/(model .*not (found|supported|available)|unknown model|invalid model|does not exist)/.test(lower)) {
    return new ProviderError(`${target}을(를) 사용할 수 없습니다. 다른 모델을 선택하세요. Details: ${detail}`, { kind: "model", provider: spec.label, model, body: detail });
  }
  if (/(overloaded|internal server error|5\d\d|service unavailable)/.test(lower)) {
    return new ProviderError(`${target} 서버 오류입니다. 잠시 후 다시 시도하세요. Details: ${detail}`, { kind: "server", provider: spec.label, model, body: detail });
  }
  return new ProviderError(`${target} CLI 호출이 실패했습니다. Details: ${detail}`, { kind: "unknown", provider: spec.label, model, body: detail });
}

abstract class SubscriptionCliClient implements AiChatClient {
  constructor(
    protected readonly provider: SubscriptionProviderId,
    protected readonly defaultModel: string,
    protected readonly runner: CliRunner = runCliProcess
  ) {}

  protected get label() {
    return CLI_SPECS[this.provider].label;
  }

  protected requireBinary(model?: string) {
    const binary = resolveCliBinary(this.provider);
    if (!binary) {
      const spec = CLI_SPECS[this.provider];
      throw providerConfigurationError(
        spec.label,
        model,
        `${spec.label} CLI(\`${spec.binary}\`)를 찾을 수 없습니다. 설치 후 로그인하거나, ${spec.envOverride} 환경 변수로 실행 파일 경로를 지정하세요.`
      );
    }
    return binary;
  }

  protected modelFor(params: { model?: string }) {
    const model = (params.model || this.defaultModel || CLI_DEFAULT_MODEL).trim();
    if (!model) throw providerConfigurationError(this.label, model, "Model is not selected");
    return model;
  }

  protected async run(model: string, binary: string, args: string[], stdin: string, cwd: string, timeoutMs: number, extraEnv: Record<string, string> = {}) {
    try {
      return await this.runner({ binary, args, stdin, cwd, env: cliEnv(this.provider, binary, extraEnv), timeoutMs });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") throw providerTimeoutError(this.label, model, timeoutMs);
      throw classifyCliFailure(this.provider, model, (error as Error)?.message || String(error));
    }
  }

  /**
   * Ask the CLI whether a subscription login exists, so Settings → Test fails fast with a login hint
   * instead of the CLI hanging on reconnects. Unknown/old CLIs that lack the subcommand are not blocked.
   */
  protected async assertLoggedIn(statusArgs: string[], isLoggedIn: (result: RunResult) => boolean | null) {
    const binary = this.requireBinary();
    const cwd = await scratchDir();
    try {
      const result = await this.runner({ binary, args: statusArgs, stdin: "", cwd, env: cliEnv(this.provider, binary), timeoutMs: 20_000 });
      if (isLoggedIn(result) === false) {
        const spec = CLI_SPECS[this.provider];
        throw new ProviderError(`${spec.label} 구독에 로그인되어 있지 않습니다. ${spec.loginHint}`, { kind: "auth", provider: spec.label });
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  abstract listModels(): Promise<ProviderModel[]>;
  protected abstract complete(params: ChatParams, images: ImagePart[]): Promise<string>;

  async chatText(params: ChatParams) {
    return this.complete(params, []);
  }

  async chatJson(params: ChatParams) {
    const messages = [...params.messages];
    messages.push({ role: "system", content: "Respond with a single valid JSON value only. Do not wrap it in Markdown code fences or add commentary." });
    return parseJsonFromText(await this.complete({ ...params, messages }, []));
  }

  async describeImage(params: { image: ImagePart; prompt: string; system?: string; model?: string; timeoutMs?: number }) {
    const messages: ChatMessage[] = [];
    if (params.system) messages.push({ role: "system", content: params.system });
    messages.push({ role: "user", content: params.prompt });
    return this.complete({ model: params.model, messages, timeoutMs: params.timeoutMs, thinking: "disabled" }, [params.image]);
  }
}

// ---------------------------------------------------------------------------
// Claude Code (Claude subscription)
// ---------------------------------------------------------------------------

export class ClaudeSubscriptionClient extends SubscriptionCliClient {
  constructor(defaultModel: string, runner?: CliRunner) {
    super("anthropic", defaultModel, runner);
  }

  async listModels(): Promise<ProviderModel[]> {
    await this.assertLoggedIn(["auth", "status"], (result) => {
      try {
        const status = JSON.parse(result.stdout) as { loggedIn?: unknown };
        return typeof status.loggedIn === "boolean" ? status.loggedIn : null;
      } catch {
        return null;
      }
    });
    return CLAUDE_MODELS.map((id) => ({ id, supportsVision: true }));
  }

  buildArgs(model: string, system: string) {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--tools", "",
      "--strict-mcp-config",
      "--no-session-persistence",
    ];
    if (model !== CLI_DEFAULT_MODEL) args.push("--model", model);
    if (system) args.push("--system-prompt", system);
    return args;
  }

  protected async complete(params: ChatParams, images: ImagePart[]) {
    const model = this.modelFor(params);
    const binary = this.requireBinary(model);
    const { system, turns } = splitSystem(params.messages);
    const content: Array<Record<string, unknown>> = images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.dataBase64 },
    }));
    content.push({ type: "text", text: renderConversation(turns) || " " });
    const stdin = `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
    const timeoutMs = effectiveTimeout(params.timeoutMs);
    const cwd = await scratchDir();
    try {
      const result = await this.run(model, binary, this.buildArgs(model, system), stdin, cwd, timeoutMs,
        params.thinking === "disabled" ? { MAX_THINKING_TOKENS: "0" } : {});
      return parseClaudeStreamResult(result, model);
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function parseClaudeStreamResult(result: RunResult, model: string) {
  type ClaudeResultEvent = { is_error?: boolean; result?: string; subtype?: string };
  let final = null as ClaudeResultEvent | null;
  const assistantTexts: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, any>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "result") final = event;
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const text = event.message.content.filter((part: any) => part?.type === "text" && part.text).map((part: any) => part.text).join("\n");
      if (text) assistantTexts.push(text);
    }
  }
  if (final?.is_error || (final && final.subtype && final.subtype !== "success")) {
    throw classifyCliFailure("anthropic", model, tail(final.result || final.subtype || result.stderr || "unknown error"));
  }
  const text = (typeof final?.result === "string" && final.result.trim()) ? final.result.trim() : assistantTexts.join("\n").trim();
  if (!final && result.code !== 0) {
    throw classifyCliFailure("anthropic", model, tail(result.stderr || result.stdout || `exit code ${result.code}`));
  }
  if (!text) throw new Error(`AI provider returned an empty message for model ${model}`);
  return text;
}

// ---------------------------------------------------------------------------
// Codex (ChatGPT subscription)
// ---------------------------------------------------------------------------

export class CodexSubscriptionClient extends SubscriptionCliClient {
  constructor(defaultModel: string, runner?: CliRunner) {
    super("openai", defaultModel, runner);
  }

  async listModels(): Promise<ProviderModel[]> {
    await this.assertLoggedIn(["login", "status"], (result) => {
      const output = `${result.stdout}\n${result.stderr}`;
      if (/not logged in/i.test(output)) return false;
      return result.code === 0 ? true : null;
    });
    const ids = [CLI_DEFAULT_MODEL, ...codexKnownModels()];
    return [...new Set(ids)].map((id) => ({ id, supportsVision: true }));
  }

  buildArgs(model: string, outputFile: string, imageFiles: string[], thinking: ChatParams["thinking"]) {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox", "read-only",
      "--color", "never",
    ];
    if (model !== CLI_DEFAULT_MODEL) args.push("--model", model);
    if (thinking === "disabled") args.push("--config", 'model_reasoning_effort="low"');
    for (const file of imageFiles) args.push(`--image=${file}`);
    args.push("--output-last-message", outputFile);
    return args;
  }

  protected async complete(params: ChatParams, images: ImagePart[]) {
    const model = this.modelFor(params);
    const binary = this.requireBinary(model);
    const { system, turns } = splitSystem(params.messages);
    const prompt = [
      "You are being used as a plain text-generation backend by a learning app.",
      "Answer directly from this prompt. Do not run shell commands, read or write files, or browse.",
      system ? `<instructions>\n${system}\n</instructions>` : "",
      renderConversation(turns),
    ].filter(Boolean).join("\n\n");
    const timeoutMs = effectiveTimeout(params.timeoutMs);
    const cwd = await scratchDir();
    try {
      const imageFiles: string[] = [];
      for (const [index, image] of images.entries()) {
        const file = join(cwd, `image-${index}.${imageExtension(image.mimeType)}`);
        await writeFile(file, Buffer.from(image.dataBase64, "base64"));
        imageFiles.push(file);
      }
      const outputFile = join(cwd, "last-message.txt");
      const result = await this.run(model, binary, this.buildArgs(model, outputFile, imageFiles, params.thinking), prompt, cwd, timeoutMs);
      const text = (await readFile(outputFile, "utf8").catch(() => "")).trim();
      if (result.code !== 0 && !text) {
        throw classifyCliFailure("openai", model, tail(result.stderr || result.stdout || `exit code ${result.code}`));
      }
      if (!text) throw new Error(`AI provider returned an empty message for model ${model}`);
      return text;
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function imageExtension(mimeType: string) {
  if (/png/i.test(mimeType)) return "png";
  if (/webp/i.test(mimeType)) return "webp";
  if (/gif/i.test(mimeType)) return "gif";
  return "jpg";
}

function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** Models Codex itself knows about: its cached model list and the model pinned in config.toml. */
export function codexKnownModels(home = codexHome()): string[] {
  const ids: string[] = [];
  try {
    const config = readFileSync(join(home, "config.toml"), "utf8");
    const match = /^\s*model\s*=\s*"([^"]+)"/m.exec(config);
    if (match?.[1]) ids.push(match[1]);
  } catch {}
  try {
    const cache = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")) as unknown;
    const list = Array.isArray(cache) ? cache : (cache as { models?: unknown[]; data?: unknown[] })?.models || (cache as { data?: unknown[] })?.data || [];
    for (const entry of list) {
      if (typeof entry === "string") ids.push(entry);
      else if (entry && typeof entry === "object") {
        const record = entry as { slug?: unknown; id?: unknown; visibility?: unknown; supported_in_api?: unknown };
        if (record.visibility === "hide" || record.visibility === "hidden") continue;
        const id = typeof record.slug === "string" ? record.slug : typeof record.id === "string" ? record.id : "";
        if (id) ids.push(id);
      }
    }
  } catch {}
  return [...new Set(ids)];
}
