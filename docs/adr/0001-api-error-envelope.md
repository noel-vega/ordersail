---
status: accepted
---

# API errors use one Stripe-style envelope, keyed by a code from a single registry

Nest's default error body has no stable identifier, so our clients match message strings, and
because `@ordersail/storefront-sdk` is published publicly, whatever shape it exposes becomes a
public contract. So every error from `merchant-api`, `storefront-api` and `pos-api` now has one
Stripe-style body whose `code` comes from a single registry in `packages/errors`: developer
experience for people building on the SDK is the deciding priority, and Stripe's is the error
contract those developers already know.

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "insufficient_stock",
    "message": "Only 3 of Tee / M left, and 2 are already in your cart.",
    "param": "quantity",
    "doc_url": "https://ordersail.com/docs/errors/insufficient-stock",
    "request_id": "01J9…",
    "details": { "variant_id": 42, "requested": 2, "in_cart": 2, "available": 3 }
  }
}
```

The registry drives the exception class the APIs throw, the one global filter that writes the
body, the `ErrorResponse` schema in each OpenAPI document, and therefore the `ErrorCode` union in
the generated SDK types. Clients branch on `code` and never on `message`.

## Context

Before this decision every API returned Nest's default `{ statusCode, message, error }`. It has
no stable identifier, and a failed DTO validation returns `message` as a `string[]`. So clients
had to branch on status or match strings:

- merchant-sdk decided whether a 401 meant an expired session by comparing `message` with
  `"Unauthorized"`. A wrong password on a password-confirmation route is also a bare 401, so the
  SDK refreshed and retried it, which burned two throttled attempts per typo.
- storefront-sdk's `do()` refreshed and retried on any 401, including a bad app key that
  refreshing can't fix.
- The only machine-readable reason anywhere was one hand-rolled payload, `MFA_FACTOR_REQUIRED`.
  Three sibling 403 guards had no code, so the SDK flattened them to "You don't have permission".
- A storefront couldn't tell "not enough stock" from any other add-to-cart failure. This is what
  prompted the decision.

Because storefront-sdk is a public npm package, whatever shape it exposes becomes a public
contract. Fixing this before launch costs one breaking SDK release; after launch it costs a
deprecation cycle.

## The fields

- **`type`** is a broad category from a fixed set, derived from the status. Clients use it for
  coarse handling ("send the user to sign in", "back off and retry"). A category is meant to be
  coarse, so every status has one through the catch-all rows:

  | Status | `type` |
  |---|---|
  | 401 | `authentication_error` |
  | 403 | `permission_error` |
  | 429 | `rate_limit_error` |
  | any other 4xx | `invalid_request_error` |
  | any 5xx | `api_error` |

- **`code`** is the specific reason. It's snake_case, stable once published, and **always
  present**. Stripe sometimes omits `code`; we don't, so a client never needs a fallback branch.
  A throw that hasn't been given a specific code gets a **generic code** by one rule: the
  status's standard reason phrase in snake_case (405 → `method_not_allowed`, 503 →
  `service_unavailable`), except for three statuses where the phrase reads badly:

  | Status | Reason phrase | Generic `code` |
  |---|---|---|
  | 401 | Unauthorized | `unauthenticated` (it means "not signed in", not "not allowed") |
  | 429 | Too Many Requests | `rate_limited` |
  | 500 | Internal Server Error | `internal_error` |

  Every status gets its own generic code, so no two statuses ever share one. Sharing would
  force a breaking change the day a client needs to tell them apart. The registry generates
  generic codes only for the statuses our stack can produce: the HTTP exceptions in
  `@nestjs/common` (except 418), plus 429 from the throttler. That's 400, 401, 403, 404, 405,
  406, 408, 409, 410, 412, 413, 415, 421, 422, 429, 500, 501, 502, 503, 504 and 505. A status
  outside that set is a bug in the thrower; it still gets `bad_request` (4xx) or
  `internal_error` (5xx), so the body is never invalid.
- **`message`** is for people, and it may change at any time. On a 5xx it's always generic: no
  upstream error text, no stack, no `cause`.
- **`param`** is the request field that caused the error, when there is one.
- **`doc_url`** is `https://ordersail.com/docs/errors/<code in kebab-case>`. It's derived from
  the code, so a reference page per code can be generated from the registry.
- **`request_id`** is the correlation ID: the same value as the `x-request-id` response header
  and the `correlationId` log field. A developer can quote it, and we can find the logs and
  trace for that request.
- **`details`** is optional data specific to the code. The registry declares its shape, so the
  SDK can type it. It's nested under one key so code-specific fields can never collide with the
  fields above.

A failed validation is `code: "validation_failed"`. `param` and `message` describe the first
failing field (as Stripe does) and `details.fields` lists every failure as `{ param, message }`,
with nested properties as dotted paths, so a form can mark all of them at once.

## Considered options

**RFC 9457 Problem Details** (`application/problem+json`: `type`, `title`, `status`, `detail`,
`instance` plus extension members). It's an IETF standard, which counted in its favour. Rejected
because its identifier is the `type` URI, which is awkward to branch on in client code. Every
practical adoption also adds a short code beside it, so you end up with two identifiers for one
thing. The SDK experience is what we're optimising for, and Stripe's shape (a short `code` plus a
`doc_url`) gives clients the same "link to the docs" benefit with a friendlier identifier. We
kept RFC 9457's best idea, a URI per error type, as `doc_url`.

**Keep Nest's default body and add codes route by route.** This is what happened with
`MFA_FACTOR_REQUIRED`. Rejected: every route invents its own shape, the OpenAPI documents can't
describe errors, so the SDK types can't either, and validation errors stay a joined string.

**A registry per API.** Rejected: the three APIs would drift, as the copied SDK error helpers
already have. One registry means a code means the same thing everywhere.

## Consequences

- **Breaking for SDK readers, once.** merchant-sdk, storefront-sdk and merchant-web switch in the
  same change as the APIs. storefront-sdk ships it as 0.7.0, a minor bump pre-1.0. A storefront
  on 0.6.0 keeps working but shows `Request failed (N)` instead of the server's message until it
  upgrades.
- **No mass migration.** Existing `NotFoundException`-style throws keep working and get generic
  codes. Specific codes are added where a client needs to tell cases apart. New errors use
  `ApiException` with a registry entry, not a bare Nest exception with a message string.
- **A code is a public contract.** Renaming or removing one is a breaking SDK change. Messages can
  be reworded freely.
- **The response body no longer comes from Nest's `BaseExceptionFilter`.** The global filter
  writes it for both Express and Fastify, and keeps the existing log events and levels.
- **Errors are now part of the OpenAPI documents**, so the API reference and the generated SDK
  types describe them. Previously every error response was an empty `content`.
