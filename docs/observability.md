# Observability — logging standard

How the backend services log, and how to use those logs to trace a bug. Applies to every
NestJS service (`merchant-api`, `storefront-api`, `pos-api`, `worker`) and anything in
`packages/` that logs.

> **Status:** in place — the **M1b — Structured logging** milestone (Observability & alerting
> project) landed as pino (OS-478) → redaction (OS-81) → request logs (OS-82) → request
> context (OS-479) → error handling (OS-480) → call-site migration (OS-481) → log alarms
> (OS-99) → saved queries (OS-98). Traces (`trace_id`/`span_id`) are M3 (OS-94).

## Roles of each tool

| Tool | Answers | Status |
|---|---|---|
| **pino → CloudWatch Logs** | *What happened, step by step?* — searched on demand | this doc |
| **Sentry** | *What broke, how often, since which release?* — emails us | `merchant-api` (OS-67); other services OS-68–72 — [Error tracking](#error-tracking-sentry) |
| **CloudWatch alarms → SNS** | *Is something down / over threshold?* — pages us | `docs/runbooks/alerts.md` |
| **OpenTelemetry traces** | *Where did the time go across services?* | deferred (OS-94) |

The **correlation ID** ties them together: it's the `x-request-id` response header, the
`correlationId` field on every log line, rides on every BullMQ job, and is the `correlation_id`
tag on every Sentry event.

## The log line

In production every line is one JSON object on stdout; ECS ships it to CloudWatch. In local
dev the same data is pretty-printed.

```json
{
  "level": 30,
  "time": 1789012345678,
  "service": "merchant-api",
  "env": "production",
  "context": "FulfillmentsService",
  "correlationId": "0b7e6c1e-2f7a-4c1a-9a55-3f0f1b1d2c3e",
  "accountId": 42,
  "userId": 7,
  "event": "fulfillment.created",
  "orderId": 1234,
  "fulfillmentId": 88,
  "msg": "Fulfillment created"
}
```

### Fields

| Field | Set by | Notes |
|---|---|---|
| `level` | pino | numeric: 20 debug, 30 info, 40 warn, 50 error, 60 fatal |
| `time` | pino | epoch ms |
| `service`, `env` | `configureLogging()` in `main.ts` | constant per process |
| `context` | `new Logger(X.name)` | class that logged |
| `msg` | caller | short, human, **no interpolated IDs or PII** |
| `correlationId` | request middleware / job processor | always present inside a request or job |
| `accountId` | auth guards / job data / Stripe webhook event | the tenant |
| `userId` | merchant-api `AuthGuard` | merchant staff member |
| `customerId` | storefront-api `CustomerAuthGuard` | logged-in storefront customer — the ID only, never their email or name |
| `deviceId`, `locationId` | pos-api `PosDeviceGuard` | paired POS device and its location |
| `appKeyId` | storefront-api `AppKeyGuard` | which storefront key was used |
| `orderId` | worker order processor, once the order is committed | also passed by hand as a domain field elsewhere |
| `event` | caller | stable dotted name, see below |
| domain IDs | caller | `orderId`, `jobId`, `queue`, `disputeId`, `chargeId`, `stripeEventId`… — top-level, camelCase |
| `err` | caller | the Error object; serialized to `type`, `message`, `stack` (+ safe provider fields) |
| `alert` | caller | `true` when a human must act — drives a critical alarm (OS-99) |
| `trace_id`, `span_id` | *reserved* | added automatically once OpenTelemetry lands (OS-94) |

Request-context fields (`correlationId`, `accountId`, `userId`, …) are attached automatically
from AsyncLocalStorage — **don't pass them by hand**. The middleware opens the scope with the
correlation ID; each auth guard adds the caller it resolved with `setLogContext()`, so every
later line of the request — service lines and the access line — carries it. A line logged
before the guard runs (or on a public route) has only `correlationId`.

### Access log

`requestLoggingMiddleware()` from `logging` (registered first in each API's `main.ts`) writes
one line per HTTP request when the response finishes:

```json
{"level":40,"service":"merchant-api","correlationId":"…","context":"HTTP","event":"http.request",
 "req":{"method":"GET"},"route":"/orders/:id","res":{"statusCode":401},"responseTime":1.5,
 "msg":"GET /orders/:id 401"}
```

- `route` is the matched **template**, never the raw URL or query string (they can carry IDs
  and tokens); `null` when nothing matched. Express reads `req.route`; Fastify (merchant-api)
  reports it via `setRequestRoute()` from an `onRequest` hook.
- Level: 5xx `error`, 4xx `warn`, otherwise `info`. A client disconnect before the response
  finishes logs `aborted: true` at `warn` with **no** `res.statusCode` (none was sent).
- `/health` is never logged.
- The same middleware owns the correlation ID: an inbound `x-request-id` is reused only if it
  matches `^[A-Za-z0-9._:-]{1,128}$` (it's untrusted input that lands on every line), otherwise
  a UUID is minted. It's echoed on the response and exposed to browsers via CORS.

## How to log

```ts
import { Logger } from 'logging';

private readonly logger = new Logger(FulfillmentsService.name);

// business event
this.logger.info({ event: 'fulfillment.created', orderId, fulfillmentId }, 'Fulfillment created');

// handled error — always pass the Error as `err`
this.logger.error({ err, event: 'shippo.label_purchase_failed', orderId }, 'Label purchase failed');

// needs a human now
this.logger.error(
  { alert: true, event: 'dispute.opened', disputeId, chargeId, orderId },
  'Stripe dispute opened — respond before the evidence deadline',
);
```

Worker job processors log the same way. Producers spread `jobLogContext()` into the job payload
(`correlationId` + `accountId` when the request had one), and the processor restores it with
`runWithLogContext(logContextOf(job.data), …)` before any work runs — `logContextOf` picks just
those fields, never the rest of the payload:

```ts
this.logger.warn(
  { err, event: 'order_job.attempt_failed', queue: 'orders', jobId: job.id, attemptsMade, attempts },
  'Order job attempt failed, will retry',
);
```

**Rules**

- Object first, message second. Never build the message with template literals carrying IDs:
  ❌ `` this.logger.log(`Order ${orderId} created for ${email}`) ``
- Errors always go in `err`. Never log only `err.message` (the stack is lost) or pass the
  stack as a separate argument.
- One line per meaningful thing. Don't log on entry *and* exit of every method.
- `log` still works as an alias of `info` (Nest's own bootstrap logs use it), but prefer `info`.

### Event names

`<domain>.<thing>_<past-tense verb>` or `<domain>.<past-tense verb>` — lowercase, dotted,
underscores within a segment. Stable: dashboards and alarms key off them, so rename deliberately.

Examples: `order.created`, `order_job.dead_lettered`, `checkout.session_created`,
`stripe.webhook_received`, `email.sent`, `email_job.failed`, `dispute.opened`,
`fulfillment.created`, `http.unhandled_error`.

`alert: true` lines today: `order_job.dead_lettered` (a paid checkout with no order) and
`dispute.opened`. Both log at `error`. Grep the code for `alert: true` for the current list.

In production, any `alert: true` line pages: a CloudWatch metric filter on each service's
log group feeds the `ordersail-<service>-alert-lines` alarm → critical topic (OS-99). A
sustained run of `error`/`fatal` lines trips `ordersail-<service>-error-lines` → warning.
So `alert: true` is a paging decision — set it only when a human must act now. Runbook:
`docs/runbooks/alerts.md`.

## Levels

| Level | Use for | In prod? |
|---|---|---|
| `fatal` | process is about to exit (uncaught exception) | yes |
| `error` | a customer/merchant was failed, or a human must act (`alert: true`) | yes — counted by alarms |
| `warn` | unexpected but handled: a retry, a 401/403/429, a degraded dependency | yes |
| `info` | business events + one access line per request | yes |
| `debug` | diagnostics while developing | no |

`LOG_LEVEL` sets the threshold: default `info` in production, `debug` elsewhere. `/health`
requests are never logged (ALB + ECS checks hit them every 15s).

## Errors

Every service's `main.ts` wires the same three things from `logging`, so an error is logged
once, as structured JSON, wherever it happens:

- **`LoggingExceptionFilter`** (`app.useGlobalFilters`) — every exception that escapes a
  controller or guard. The response is unchanged (it answers through Nest's
  `BaseExceptionFilter`, so Express and Fastify behave the same, and clients never see a stack).
  The log line:

  | Status | Level | Line |
  |---|---|---|
  | 5xx, or anything that isn't an `HttpException` | `error` | `{ err, event: 'http.unhandled_error', route, status }` — with the stack |
  | 401 / 403 / 429 | `warn` | `{ event: 'http.request_rejected', route, status, reason }` — no stack |
  | other 4xx (validation, not found, 413…) | `debug` | same as above |

  Nest's own unstructured `ExceptionsHandler` line is suppressed so each error shows up once.
  The access line for the same request is still written separately. Don't catch-and-rethrow
  just to log: throw, and let the filter log it.
- **`installProcessHandlers()`** — an uncaught exception or unhandled rejection logs one
  `fatal` line (`process.uncaught_exception` / `process.unhandled_rejection`), flushes, then
  exits 1. The process still crashes, same as Node's default. The difference is that the last
  thing in the log is now a line an alarm can match. Both events have their own listener, so
  this keeps working when something else (a library, Sentry) also listens for
  `unhandledRejection`, or under `--unhandled-rejections=warn`.
- **`bootstrap().catch((err) => exitOnFatal(err, 'app.boot_failed'))`** — the same path for a
  failed boot (the worker crash-at-boot incident used to leave only a raw stderr trace).
- **`parseEnv`** (`packages/config`) — an invalid environment is also a failed boot, but it's
  caught on import, before the handlers above are installed. So `parseEnv` logs its own `fatal`
  `app.boot_failed` line, with `issues: [{ path, message }]` (the variable names, never their
  values), and exits 1.
- **`installShutdownHandler(app)`** — on SIGTERM (an ECS deploy or scale-in) or SIGINT, it:
  1. logs `process.shutdown_started`;
  2. calls `app.close()`, which runs every shutdown hook (the worker's BullMQ consumers let the
     in-flight job finish);
  3. flushes the logs and exits 0.

  A second signal of either kind logs `process.shutdown_forced` and exits 1 immediately, so
  `close()` never runs twice. If `close()` hasn't finished within 25s, it logs `fatal`
  `process.shutdown_timed_out` and exits 1, before ECS's SIGKILL at the 30s stop timeout would
  end it silently. Use this instead of `app.enableShutdownHooks()`: Nest's version re-raises
  the signal after closing, and that kills the process before the log stream is flushed.

Worker job failures log from the `failed` handlers:

- A retryable attempt logs at `warn` (`order_job.attempt_failed`, `email_job.attempt_failed`).
- The last attempt logs at `error` (`order_job.failed`, `email_job.failed`), with
  `{ err, queue, jobId, jobName, attemptsMade, attempts }`.

## Error tracking (Sentry)

`packages/observability` wires Sentry into the error paths above — nothing else captures. Each
service calls `initSentry({ service, dsn, environment, release })` from `src/instrument.ts`, the
first import in `main.ts`. With no `SENTRY_DSN` it does nothing, which is the default in local
dev, tests and CI.

- **What's reported:** every exception `LoggingExceptionFilter` logs at `error` (5xx), except on
  `/health` (a 503 while a dependency is down is the alarms' job, and probes would burn the
  quota), plus every `exitOnFatal` crash at level `fatal`, flushed before the process exits.
  4xx never is. `packages/logging` doesn't import Sentry; it exposes `setErrorReporter`, and
  `observability` plugs in.
- **Tags:** `service`, `event`, `route`, `status`, and the request's / job's log context as
  `correlation_id`, `account_id`, `user_id`, `customer_id`, `device_id`, … (same values as the
  log line, snake_case). `release` is the deployed git SHA and `environment` is `production`.
- **What's never sent:** request bodies, cookies, query strings, local variables, queue job
  arguments, user details (all off in `dataCollection`). Request headers are an allow-list
  (`accept`, `content-length`, `content-type`, `host`, `user-agent`, `x-request-id`). The
  `SENSITIVE_KEYS` above are redacted in `extra`, `contexts` and breadcrumbs. Console
  breadcrumbs are off (our logs are pino; console is only library chatter).
- **Routing:** one Sentry project per deployable. Sentry alerts go to email; paging stays on
  SNS (`docs/runbooks/alerts.md`), so there is one pager.
- **Production config:** `SENTRY_DSN` is a key in the service's Secrets Manager secret
  (`ordersail/production/<app>`; the repo is public and a DSN lets anyone spend the event quota),
  `SENTRY_ENVIRONMENT` is a plain task-def env var, and `cd.yml` stamps `SENTRY_RELEASE` into each
  task def revision it registers, so a rollback reports the older SHA.

## Personal data & secrets

Logs are retained 30 days and readable by anyone with CloudWatch access. **Log IDs, not people.**

Never log:

- email addresses, names, phone numbers, postal addresses
- passwords, password-reset / invite / verify / magic-link tokens, MFA codes
- JWTs, cookies, `Authorization` headers, app keys, POS device tokens, cart tokens
- Stripe/Shippo secrets, card data, full provider request params
- request or response bodies

If an address is genuinely needed to debug (rare), use `maskEmail()` from `logging`
(`j***@example.com`). The same rules apply to SNS alert text and Sentry events.

`packages/logging` is the **safety net**, not a replacement for these rules:

- `REDACT_PATHS` censors credential headers (`authorization`, `cookie`, `set-cookie`,
  `x-app-key`, `x-pos-device-token`, `x-cart-token`) and keys such as `password`, `token`,
  `secret`, `apiKey`, `cartToken`, `email`, `customerEmail`, `phone` — as `[REDACTED]`.
- Keys are only matched at the top level of the fields object **or one level below**
  (pino has no recursive wildcard). Deeper payloads aren't covered — don't log them.
- Generic keys (`to`, `code`, `name`, `address`) are intentionally not redacted; don't put
  PII under them.
- `err` is serialized from an allow-list (`type`, `message`, `stack`, `code`, `statusCode`,
  `requestId`, `param`, `cause`), so provider error payloads (Stripe `raw`/`headers`, Shippo
  `rawResponse`/`body`) never reach the log. A non-`Error` value (a rejected plain object, an
  object `cause`, or Nest-style `detail`) is reduced to its type and a string `message`.

## Tracing a bug

**Find the correlation ID**

- From the browser: the `x-request-id` response header in devtools (readable from JS too).
- From a Sentry issue: the `correlation_id` tag (`merchant-api` so far; the rest in OS-68/69).
- From an order or job: search by `orderId` / `jobId` first, then read `correlationId` off the line.

**Local dev** — the apps log to the terminal running `npm run dev` (`npm run logs` only
follows the Docker infra containers). To search, capture it to a file:

```bash
npm run dev 2>&1 | tee dev.log          # in one terminal
grep 0b7e6c1e-2f7a-4c1a-9a55-3f0f1b1d2c3e dev.log
```

**Production** — CloudWatch Logs Insights → **Saved queries** → the `ordersail/` folder
(`infra/terraform/envs/production/log-queries.tf`, OS-98). Each one is pre-set to all four
service log groups — `/ecs/ordersail-merchant-api`, `-storefront-api`, `-pos-api`, `-worker` —
so API → worker hops show up in one timeline. Pick the time range, edit the placeholder on the
`filter` line where there is one (`"PASTE-CORRELATION-ID"`, or `0` for a numeric ID), run.

| Saved query | Use it for | Edit |
|---|---|---|
| `ordersail/Request timeline` | everything for one request, API and the jobs it enqueued | `correlationId` |
| `ordersail/Account activity` | one tenant's lines | `accountId` |
| `ordersail/Order history` | every line naming an order — creation, fulfillment, refunds (email jobs carry no `orderId`; follow them via `correlationId`) | `orderId` |
| `ordersail/POS device activity` | one paired POS device (pos-api) | `deviceId` |
| `ordersail/Errors by service` | `error` + `fatal` lines, counted by `service`, `event` | — |
| `ordersail/Alerts` | `alert: true` lines — what the alert-lines alarm fired on | — |
| `ordersail/Slow requests` | access lines over 1s: count, p95, max by `route` | — |
| `ordersail/4xx-5xx by route` | failed requests by `route` and status | — |

The query text lives in Terraform only; change it there and apply. Writing your own: filter on
booleans with `= 1`, not `= true` (Logs Insights exposes JSON booleans as 1/0), and nested
fields with a dot (`res.statusCode`, `err.message`).
