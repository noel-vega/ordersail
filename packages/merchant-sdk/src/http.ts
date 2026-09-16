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
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
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
  const body = result.error;
  const raw =
    body && typeof body === "object" && "message" in body
      ? (body as { message: unknown }).message
      : undefined;
  const message = Array.isArray(raw)
    ? raw.join(", ")
    : typeof raw === "string" && raw
      ? raw
      : `Request failed (${result.response.status})`;
  throw new ApiError(message, result.response.status);
}
