export function normalizeApiBaseUrl(baseUrl: string): string;
export function buildApiUrl(baseUrl: string, path: string): URL;
export function buildApiRequestInit(input?: {
  method?: string;
  token?: string | null;
  body?: unknown;
  headers?: HeadersInit;
}): RequestInit;
export function parseApiJsonBody(response: Response): Promise<unknown>;
