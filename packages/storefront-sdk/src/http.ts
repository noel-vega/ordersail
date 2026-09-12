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
// message instead of a generic string.
export function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (result.data !== undefined) return result.data;
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
