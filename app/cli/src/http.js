import { buildApiRequestInit, buildApiUrl, parseApiJsonBody } from "../../shared/request-runtime.js";

const DEFAULT_API_BASE = "http://127.0.0.1:8787/api/v1";

export function getApiBase(argvOptions = {}, env = process.env) {
  return (
    argvOptions.api ||
    env.RECALLX_API_URL ||
    DEFAULT_API_BASE
  );
}

export function getAuthToken(argvOptions = {}, env = process.env) {
  return argvOptions.token || env.RECALLX_API_TOKEN || env.RECALLX_TOKEN || "";
}

export async function requestJson(apiBase, path, { method = "GET", token, body } = {}) {
  const response = await fetch(
    buildApiUrl(apiBase, path),
    buildApiRequestInit({ method, token, body }),
  );

  let payload = null;
  let parseError = null;
  try {
    payload = await parseApiJsonBody(response);
  } catch (error) {
    parseError = error;
  }

  if (!response.ok) {
    const error = payload?.error;
    const code = error?.code || `HTTP_${response.status}`;
    const message = error?.message || response.statusText || "Request failed";
    throw new Error(`${code}: ${message}`);
  }

  if (parseError) {
    throw new Error("INVALID_RESPONSE: RecallX API returned non-JSON output.");
  }

  if (payload && payload.ok === false) {
    const error = payload.error || {};
    throw new Error(`${error.code || "INTERNAL_ERROR"}: ${error.message || "Request failed"}`);
  }

  return payload ?? {};
}
