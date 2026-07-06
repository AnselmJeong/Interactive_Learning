export type ProviderErrorKind = "auth" | "model" | "rate_limit" | "server" | "timeout" | "network" | "configuration" | "unknown";

export type ProviderErrorDetails = {
  kind: ProviderErrorKind;
  status?: number;
  provider?: string;
  model?: string;
  body?: string;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly body?: string;

  constructor(message: string, details: ProviderErrorDetails) {
    super(message);
    this.name = "ProviderError";
    this.kind = details.kind;
    this.status = details.status;
    this.provider = details.provider;
    this.model = details.model;
    this.body = details.body;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

export function providerConfigurationError(provider: string, model: string | undefined, message: string) {
  return new ProviderError(message, { kind: "configuration", provider, model });
}

export function providerTimeoutError(provider: string, model: string | undefined, timeoutMs = 120000) {
  return new ProviderError(
    `${provider} request timed out after ${Math.round(timeoutMs / 1000)}s${model ? ` for model ${model}` : ""}. 잠시 후 다시 시도해 주세요.`,
    { kind: "timeout", provider, model }
  );
}

export function providerNetworkError(error: unknown, provider: string, model?: string) {
  const message = (error as Error)?.message || String(error);
  return new ProviderError(`${provider} request failed before a response arrived: ${message}`, {
    kind: "network",
    provider,
    model,
    cause: error,
  });
}

export async function providerHttpError(response: Response, provider: string, model?: string, prefix = "AI provider") {
  const body = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 700);
  const status = response.status;
  return new ProviderError(providerHttpMessage(status, provider, model, body, prefix), {
    kind: providerErrorKindForStatus(status),
    status,
    provider,
    model,
    body,
  });
}

export function providerErrorKindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "unknown";
}

function providerHttpMessage(status: number, provider: string, model: string | undefined, body: string, prefix: string) {
  const target = model ? `${provider} model ${model}` : provider;
  const tail = body ? ` Details: ${body}` : "";
  if (status === 401 || status === 403) return `${target} rejected this request (${status}). The API key may be valid for model listing but not authorized for this model/action, or the saved key/account access may need checking.${tail}`;
  if (status === 404) return `${target} was not found (${status}). Check the model name and base URL.${tail}`;
  if (status === 429) return `${target} hit a quota or rate limit (${status}). Wait or choose another provider/model.${tail}`;
  if (status >= 500) return `${target} returned a server error (${status}). This is usually retryable.${tail}`;
  return `${prefix} HTTP ${status} from ${target}.${tail}`;
}
