// Typed API errors so callers can make safe decisions (e.g. "was the order maybe accepted?").

export class ApiError extends Error {
  /**
   * kind: 'rate_limit' | 'timeout' | 'network' | 'server' | 'client' | 'auth' | 'not_found' | 'conflict' | 'malformed'
   */
  constructor(kind, message, { status = null, retryAfterMs = null, endpoint = "", body = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.endpoint = endpoint;
    this.body = typeof body === "string" ? body.slice(0, 500) : "";
  }

  /** True when a write request MAY have been processed by the exchange. */
  get outcomeUnknown() {
    return this.kind === "timeout" || this.kind === "network" || this.kind === "server" || this.kind === "conflict" || this.kind === "malformed";
  }

  get retryable() {
    return this.kind === "timeout" || this.kind === "network" || this.kind === "server" || this.kind === "rate_limit";
  }
}

export function classifyStatus(status) {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "server";
  return "client";
}
