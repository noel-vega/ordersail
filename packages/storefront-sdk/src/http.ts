import type { components } from "./types.gen.js";

export type DoRequest<T> = () => Promise<{
  data?: T;
  error?: unknown;
  response: Response;
}>;

// shape of StorefrontClient's private 401-retry wrapper — resource factories
// take this in instead of importing StorefrontClient itself, which would be
// circular
export type DoFn = <T>(
  request: DoRequest<T>,
) => Promise<{ data?: T; error?: unknown; response: Response }>;

// The error body every storefront-api error carries
// (docs/adr/0001-api-error-envelope.md in the OrderSail repo).
export type ErrorBody = components["schemas"]["ErrorResponse"]["error"];
// Every code the API can return. Branch on these, never on `message`, which is
// written for people and may be reworded at any time.
export type ApiErrorCode = ErrorBody["code"];
export type ApiErrorType = ErrorBody["type"];

// A non-2xx response from the API.
//
// - `code` is what to branch on (`email_taken`, `invalid_credentials`, …). It's
//   undefined only when the response carried no error body at all (a proxy's
//   or the network's error page).
// - `type` is the broad category (`invalid_request_error`, `api_error`, …).
// - `message` is the server's message, or `Request failed (<status>)` when
//   there was no error body.
// - `param` names the request field at fault, when there is one; on
//   `validation_failed`, `details.fields` lists every failing field.
// - `requestId` is the request's x-request-id: quote it when reporting a
//   problem.
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

// The `details` shape for each code that has one. The API's OpenAPI document
// types `details` only as an object so far, so these mirror the server's
// registry (packages/errors DetailsByCode) by hand until per-code schemas
// reach the document.
export interface ApiErrorDetails {
  validation_failed: { fields: { param: string; message: string }[] };
}

type DetailsFor<C extends ApiErrorCode> = C extends keyof ApiErrorDetails
  ? ApiErrorDetails[C]
  : Record<string, unknown> | undefined;

// Narrows an unknown caught value to an ApiError, optionally with a given
// code, and narrows `details` to that code's shape:
//
//   catch (err) {
//     if (isApiError(err, "validation_failed")) {
//       for (const { param, message } of err.details.fields) showFieldError(param, message);
//     }
//   }
export function isApiError<C extends ApiErrorCode>(
  err: unknown,
  code?: C,
): err is ApiError & { code: C; details: DetailsFor<C> } {
  return err instanceof ApiError && (code === undefined || err.code === code);
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

// Whether a 401 is one a token refresh could fix: the customer guard's
// `invalid_access_token`. Any other 401 — a bad app key, wrong credentials —
// would fail again after a refresh.
export function isStaleTokenError(body: unknown): boolean {
  return readErrorBody(body)?.code === "invalid_access_token";
}

function toApiError(result: { error?: unknown; response: Response }): ApiError {
  const body = readErrorBody(result.error);
  return new ApiError(
    body?.message ?? `Request failed (${result.response.status})`,
    result.response.status,
    body,
  );
}

// openapi-fetch resolves non-2xx as { error } rather than throwing. Resource
// methods use this so callers can `try/catch` an ApiError.
//
// Success is `response.ok`, not "data is defined": an endpoint with no body
// (204) legitimately resolves with `data: undefined` on success.
export function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (result.response.ok) return result.data as T;
  throw toApiError(result);
}

// A few reads have exactly one well-understood "no data" outcome (a lookup
// miss, or "not currently signed in") — anything else is a real failure and
// should surface as ApiError just like a mutation, not collapse to the same
// undefined a caller can't distinguish from the expected case.
//
// A bad app key is never the expected outcome, even on a read whose expected
// status is 401: it's a misconfigured integration, and reading it as "not
// signed in" would hide that.
export function unwrapOrUndefinedOn<T>(
  result: { data?: T; error?: unknown; response: Response },
  expectedStatus: number,
): T | undefined {
  if (result.response.ok) return result.data as T;
  const misconfigured = readErrorBody(result.error)?.code === "invalid_app_key";
  if (result.response.status === expectedStatus && !misconfigured) return undefined;
  throw toApiError(result);
}
