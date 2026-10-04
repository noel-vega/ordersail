---
status: accepted
---

# API errors use one Stripe-style envelope, keyed by a code from a single registry

Nest's default error body has no stable identifier, so our clients match message strings.
Instead, every error from `merchant-api`, `storefront-api` and `pos-api` gets one Stripe-style
body whose `code` comes from a single registry in `packages/errors`. Developer experience for
people building on the public `@ordersail/storefront-sdk` is the deciding priority, and Stripe's
is the error contract those developers already know.

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

The registry is the only definition of the codes. Each API's error handling, the `ErrorResponse`
schema in its OpenAPI document, and therefore the `ErrorCode` union in the generated SDK types all
come from it. The contract doesn't depend on the APIs' framework or language, so the registry
must stay readable as plain data: an API rewritten outside Node reads it rather than keeping its
own copy. Clients branch on `code` and never on `message`.

## Context

Before this decision every API returned Nest's default `{ statusCode, message, error }`. It has
no stable identifier, and a failed DTO validation returns `message` as a `string[]`. So clients
had to branch on status or match strings:

- merchant-sdk decides whether a 401 means an expired session by comparing `message` with
  `"Unauthorized"`. Until that check was added, it refreshed and retried every 401, so a wrong
  password on a password-confirmation route burned two throttled attempts per typo. The fix
  works only as long as no handler's 401 message happens to be the word "Unauthorized".
- storefront-sdk's `do()` refreshes and retries on any 401, including a bad app key that
  refreshing can't fix.
- The only machine-readable reason anywhere is one hand-rolled payload, `MFA_FACTOR_REQUIRED`.
  Three sibling 403 guards have no code, so the SDK flattens them to "You don't have permission".
- A storefront can't tell "not enough stock" from any other add-to-cart failure. This is what
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
  An error that hasn't been given a specific code gets a **generic code** by one rule: the
  status's reason phrase from RFC 9110, in snake_case (413 → `content_too_large`, 422 →
  `unprocessable_content`). The source is the RFC, not any framework's names for the statuses,
  because frameworks disagree (Nest says "Payload Too Large", for one) and an API may change
  framework or language. Three statuses get a better name than their phrase:

  | Status | Reason phrase | Generic `code` |
  |---|---|---|
  | 401 | Unauthorized | `unauthenticated` (it means "not signed in", not "not allowed") |
  | 429 | Too Many Requests (RFC 6585) | `rate_limited` |
  | 500 | Internal Server Error | `internal_error` |

  The registry has a generic code for each status in a fixed set: 400, 401, 403, 404, 405, 406,
  408, 409, 410, 412, 413, 415, 421, 422, 429, 500, 501, 502, 503, 504 and 505. No two statuses
  in the set share a code, because sharing would force a breaking change the day a client needs
  to tell them apart. A status outside the set is a bug in the thrower. It falls back to
  `bad_request` (4xx) or `internal_error` (5xx), sharing that code with 400 or 500, so the body
  is never invalid. The fix for such a bug is to add the status to the set, with its own code.
- **`message`** is for people, and it may change at any time. On a 5xx it's always generic: no
  upstream error text, no stack, no `cause`.
- **`param`** is the request field that caused the error, when there is one.
- **`doc_url`** is `https://ordersail.com/docs/errors/<code in kebab-case>`. It's derived from
  the code, so a reference page per code can be generated from the registry. The pages don't
  exist yet (OS-597 builds them), so until then a `doc_url` may not resolve.
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

**Keep Nest's default body.** Rejected: it has no stable identifier, so clients keep matching
message strings, and validation errors stay a `string[]` that clients join into one string.

**Hand-add codes route by route.** This is what happened with `MFA_FACTOR_REQUIRED`. Rejected:
every route invents its own shape, and the OpenAPI documents can't describe errors, so the SDK
types can't either.

**A registry per API.** Rejected: the three APIs would drift, as the copied SDK error helpers
already have. One registry means a code means the same thing everywhere.

## Consequences

- **Breaking for SDK readers, once.** merchant-sdk, storefront-sdk and merchant-web switch in the
  same change as the APIs. storefront-sdk ships it as 0.7.0, a minor bump pre-1.0. A storefront
  on 0.6.0 keeps working but shows `Request failed (N)` instead of the server's message until it
  upgrades. pos-sdk doesn't read error bodies today, so nothing in POS breaks; it gains the
  envelope fields in a follow-up.
- **No mass migration.** Existing throws that only set a status keep working and get generic
  codes. Specific codes are added where a client needs to tell cases apart. New errors name a
  registry code, not just a status and a message string.
- **A code is a public contract.** Renaming or removing one is a breaking SDK change. Messages can
  be reworded freely.
- **Each API writes the body itself, in one place.** Framework default error bodies are
  replaced, not wrapped, and the existing log events and levels stay as they are.
- **Errors become part of the OpenAPI documents**, so the API reference and the generated SDK
  types describe them. Today every error response except the `/health` 503 has an empty
  `content`.
