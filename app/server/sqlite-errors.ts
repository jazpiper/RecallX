type SqliteLikeError = {
  code?: unknown;
  errstr?: unknown;
  message?: unknown;
};

export function isReadonlySqliteWriteError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as SqliteLikeError;
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const errstr = typeof candidate.errstr === "string" ? candidate.errstr.toLowerCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";

  return code === "ERR_SQLITE_ERROR" && (errstr.includes("readonly database") || message.includes("readonly database"));
}
