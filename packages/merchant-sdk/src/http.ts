import type { components } from "./types.gen.js";

export type DoRequest<T> = () => Promise<{
  data?: T;
  error?: unknown;
  response: Response;
}>;

// shape of AdminClient's private 401-retry wrapper — resource factories take
// this in instead of importing AdminClient itself, which would be circular
export type DoFn = <T>(
  request: DoRequest<T>,
) => Promise<{ data?: T; error?: unknown; response: Response }>;

// The error body every merchant-api error carries (docs/adr/0001-api-error-envelope.md).
export type ErrorBody = components["schemas"]["ErrorResponse"]["error"];
// The registry's codes; branch on these, never on `message`.
export type ApiErrorCode = ErrorBody["code"];
export type ApiErrorType = ErrorBody["type"];

// A non-2xx response from the API. `message` is the server's message (written
// for people; never parse it), or a fallback when the response carried no
// envelope (a proxy's or the network's error page).
//
// `code` is what a caller branches on: `mfa_factor_required` to offer setting
// up a factor, `invalid_access_token` to refresh, and so on. It's undefined
// only when there was no envelope. `requestId` is the request's
// x-request-id, worth quoting in a bug report.
export class ApiError extends Error {
  readonly status: number;
  readonly type: ApiErrorType | undefined;
  readonly code: ApiErrorCode | undefined;
  readonly param: string | undefined;
  readonly docUrl: string | undefined;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, status: number, body?: ErrorBody) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = body?.type;
    this.code = body?.code;
    this.param = body?.param;
    this.docUrl = body?.doc_url;
    this.requestId = body?.request_id ?? undefined;
    this.details = body?.details;
  }
}

// The envelope's `error` object, or undefined when the body isn't one.
export function readErrorBody(body: unknown): ErrorBody | undefined {
  if (!body || typeof body !== "object" || !("error" in body)) return undefined;
  const error = (body as { error: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string"
    ? (error as ErrorBody)
    : undefined;
}

// Whether a 401 is one that re-authenticating could actually fix: the auth
// guard's `invalid_access_token` (missing, expired or invalid token). Any
// other 401 — a wrong current password, say — came from a handler that
// authenticated the caller and refused for a reason of its own; refreshing
// and replaying it can only fail again, while spending a second attempt from
// the route's rate limit.
export function isStaleTokenError(body: unknown): boolean {
  return readErrorBody(body)?.code === "invalid_access_token";
}

// openapi-fetch resolves non-2xx as { error } rather than throwing. Resource
// methods that mutate use this so callers can `try/catch` and show the API's
// message (e.g. a 409 from an over-refund) instead of a generic string.
//
// Success is `response.ok`, not "data is defined" — a void-returning
// endpoint (e.g. disable/revoke, 200/201/204 with no body) legitimately
// resolves with `data: undefined` on success, and treating that as failure
// surfaced as a real bug (a successful 201 showing "Request failed (201)").
export function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (result.response.ok) return result.data as T;
  const body = readErrorBody(result.error);
  throw new ApiError(
    body?.message ?? `Request failed (${result.response.status})`,
    result.response.status,
    body,
  );
}
