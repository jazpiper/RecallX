import type { ApiEnvelope, ApiErrorEnvelope } from "../shared/types.js";
import { buildApiRequestInit, buildApiUrl, parseApiJsonBody } from "../shared/request-runtime.js";
import { currentTelemetryContext } from "../server/observability.js";

export class MemforgeApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, options?: { status?: number; code?: string; details?: unknown }) {
    super(message);
    this.name = "MemforgeApiError";
    this.status = options?.status ?? 500;
    this.code = options?.code ?? "MEMFORGE_API_ERROR";
    this.details = options?.details;
  }
}

function isApiErrorEnvelope(payload: unknown): payload is ApiErrorEnvelope {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "ok" in payload &&
      payload.ok === false &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object"
  );
}

export class MemforgeApiClient {
  readonly baseUrl: string;
  readonly apiToken: string | null;

  constructor(baseUrl: string, apiToken?: string | null) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken ?? null;
  }

  async get<T>(path: string) {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }

  async patch<T>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = new Headers();

    const telemetryContext = currentTelemetryContext();
    if (telemetryContext?.traceId) {
      headers.set("x-memforge-trace-id", telemetryContext.traceId);
    }
    if (telemetryContext?.toolName) {
      headers.set("x-memforge-mcp-tool", telemetryContext.toolName);
    }

    let response: Response;
    try {
      response = await fetch(
        buildApiUrl(this.baseUrl, path),
        buildApiRequestInit({
          method,
          token: this.apiToken,
          body,
          headers
        })
      );
    } catch (error) {
      throw new MemforgeApiError("Failed to reach the local Memforge API.", {
        status: 503,
        code: "NETWORK_ERROR",
        details: error
      });
    }

    let payload: ApiEnvelope<unknown> | ApiErrorEnvelope | Record<string, unknown> | null;
    try {
      payload = await parseApiJsonBody(response) as ApiEnvelope<unknown> | ApiErrorEnvelope | Record<string, unknown> | null;
    } catch (error) {
      throw new MemforgeApiError("Memforge API returned non-JSON output.", {
        status: response.status,
        code: "INVALID_RESPONSE",
        details: error
      });
    }
    if (!payload || typeof payload !== "object") {
      throw new MemforgeApiError("Memforge API returned an empty response.", {
        status: response.status,
        code: "EMPTY_RESPONSE"
      });
    }

    if ("ok" in payload && payload.ok === true) {
      return payload.data as T;
    }

    if (isApiErrorEnvelope(payload)) {
      throw new MemforgeApiError(payload.error.message, {
        status: response.status,
        code: payload.error.code,
        details: payload.error.details
      });
    }

    if (!response.ok) {
      throw new MemforgeApiError(`Memforge API request failed with status ${response.status}.`, {
        status: response.status,
        code: "HTTP_ERROR",
        details: payload
      });
    }

    return payload as T;
  }
}
