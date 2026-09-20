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

// A non-2xx response from the API. `message` is the server's message when it
// sends one (NestJS `{ message }`, string or string[]), otherwise a fallback.
//
// `code` is a machine-readable discriminator the API attaches to the
// exceptions a caller has to *branch* on rather than just display. A plain
// message can't be branched on without string matching, which breaks the
// moment the wording changes.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// NestJS error bodies are `{ message, ...}` where message is a string or, from
// the validation pipe, an array of them. A handler can also throw an object
// literal, which is how `code` arrives.
export function readErrorBody(body: unknown): {
  message: string | undefined;
  code: string | undefined;
} {
  if (!body || typeof body !== "object")
    return { message: undefined, code: undefined };
  const raw = "message" in body ? (body as { message: unknown }).message : undefined;
  const message = Array.isArray(raw)
    ? raw.join(", ")
    : typeof raw === "string" && raw
      ? raw
      : undefined;
  const rawCode = "code" in body ? (body as { code: unknown }).code : undefined;
  return { message, code: typeof rawCode === "string" ? rawCode : undefined };
}

// Whether a 401 is one that re-authenticating could actually fix.
//
// AuthGuard rejects a missing, expired or invalid token with a bare
// `new UnauthorizedException()`, which NestJS serializes with the single-word
// message "Unauthorized". A 401 carrying any other message came from a
// handler that authenticated the caller perfectly well and is refusing for a
// reason of its own — a wrong current password, say. Refreshing the token and
// replaying that request can only ever fail again, while spending a second
// attempt from whatever rate limit the route carries.
//
// Keyed on the absence of a handler message rather than on matching any
// particular wording, so rephrasing a handler's message can't silently turn
// its 401 back into a retried one.
export function isStaleTokenError(body: unknown): boolean {
  const { message } = readErrorBody(body);
  return message === undefined || message === "Unauthorized";
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
  const { message, code } = readErrorBody(result.error);
  throw new ApiError(
    message ?? `Request failed (${result.response.status})`,
    result.response.status,
    code,
  );
}
