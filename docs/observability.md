# Observability — logging standard

How the backend services log, and how to use those logs to trace a bug. Applies to every
NestJS service (`merchant-api`, `storefront-api`, `pos-api`, `worker`) and anything in
`packages/` that logs.

> **Status:** this is the target contract for the **M1b — Structured logging** milestone
> (Observability & alerting project). It lands incrementally:
> pino (OS-478) → redaction (OS-81) → request logs (OS-82) → request context (OS-479) →
> error handling (OS-480) → call-site migration (OS-481) → log alarms (OS-99) →
> saved queries (OS-98). Until OS-481 merges, older call sites still log interpolated
> strings and `[alert]`-prefixed lines. New code follows this doc now.

## Roles of each tool

| Tool | Answers | Status |
|---|---|---|
| **pino → CloudWatch Logs** | *What happened, step by step?* — searched on demand | this doc |
| **Sentry** | *What broke, how often, since which release?* — alerts us | not yet integrated (OS-67–72) |
| **CloudWatch alarms → SNS** | *Is something down / over threshold?* — pages us | `docs/runbooks/alerts.md` |
| **OpenTelemetry traces** | *Where did the time go across services?* | deferred (OS-94) |

The **correlation ID** ties them together: it's the `x-request-id` response header, the
`correlationId` field on every log line, rides on every BullMQ job, and (later) is a Sentry tag.

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
| `accountId` | auth guards / job data | the tenant |
| `userId` | merchant-api `AuthGuard` | merchant staff member |
| `customerId` | storefront-api customer auth | logged-in storefront customer |
| `deviceId` | pos-api `PosAuthGuard` | paired POS device |
| `appKeyId` | storefront-api `AppKeyGuard` | which storefront key was used |
| `event` | caller | stable dotted name, see below |
| domain IDs | caller | `orderId`, `jobId`, `queue`, `disputeId`, `chargeId`, `stripeEventId`… — top-level, camelCase |
| `err` | caller | the Error object; serialized to `type`, `message`, `stack` (+ safe provider fields) |
| `alert` | caller | `true` when a human must act — drives a critical alarm (OS-99) |
| `trace_id`, `span_id` | *reserved* | added automatically once OpenTelemetry lands (OS-94) |

Request-context fields (`correlationId`, `accountId`, `userId`, …) are attached automatically
from AsyncLocalStorage — **don't pass them by hand**.

Access-log lines (one per HTTP request, OS-82) additionally carry `req.method`, `route`
(the template, e.g. `/orders/:id`), `res.statusCode` and `responseTime` (ms).

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

Worker job processors log the same way; the processor restores `correlationId` (and
`accountId`) from the job data before any work runs:

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
`checkout.webhook_received`, `checkout.webhook_signature_failed`, `email.sent`,
`email_job.failed`, `dispute.opened`, `http.unhandled_error`.

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

- From the browser: the `x-request-id` response header in devtools (exposed via CORS, OS-82).
- From a Sentry issue: the `correlation_id` tag — *pending: no Sentry integration yet (OS-67, OS-72)*.
- From an order or job: search by `orderId` / `jobId` first, then read `correlationId` off the line.

**Local dev** — the apps log to the terminal running `npm run dev` (`npm run logs` only
follows the Docker infra containers). To search, capture it to a file:

```bash
npm run dev 2>&1 | tee dev.log          # in one terminal
grep 0b7e6c1e-2f7a-4c1a-9a55-3f0f1b1d2c3e dev.log
```

**Production** — CloudWatch Logs Insights over the service log groups
`/ecs/ordersail-merchant-api`, `/ecs/ordersail-storefront-api`, `/ecs/ordersail-pos-api`,
`/ecs/ordersail-worker` (select all four so API → worker hops show up in one timeline).
Saved versions of these queries land with OS-98.

Everything for one request (API and the jobs it enqueued):

```
fields @timestamp, service, level, event, msg, err.message
| filter correlationId = "0b7e6c1e-2f7a-4c1a-9a55-3f0f1b1d2c3e"
| sort @timestamp asc
```

Everything for one account in a window:

```
fields @timestamp, service, event, msg, userId, correlationId
| filter accountId = 42
| sort @timestamp desc
| limit 200
```

Errors by service and event:

```
filter level >= 50
| stats count() by service, event
| sort count() desc
```

Lines that need a human:

```
fields @timestamp, service, event, msg, orderId, disputeId
| filter alert = 1
| sort @timestamp desc
```

(`= 1`, not `= true`: Logs Insights exposes JSON booleans as 1/0 and filters must compare
against 1/0.)
