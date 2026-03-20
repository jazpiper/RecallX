export function normalizeApiBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

export function buildApiUrl(baseUrl, path) {
  return new URL(`${normalizeApiBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`);
}

export function buildApiRequestInit({ method = "GET", token, body, headers } = {}) {
  const requestHeaders = new Headers(headers ?? {});
  if (!requestHeaders.has("accept")) {
    requestHeaders.set("accept", "application/json");
  }
  if (body !== undefined && !requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }
  if (token) {
    requestHeaders.set("authorization", `Bearer ${token}`);
  }

  return {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

export async function parseApiJsonBody(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  return JSON.parse(text);
}
