# Observability — logging standard

How the backend services log, and how to use those logs to trace a bug. Applies to every
NestJS service (`merchant-api`, `storefront-api`, `pos-api`, `worker`) and anything in
`packages/` that logs.

> **Status:** in place — the **M1b — Structured logging** milestone (Observability & alerting
> project) landed as pino (OS-478) → redaction (OS-81) → request logs (OS-82) → request
> context (OS-479) → error handling (OS-480) → call-site migration (OS-481) → log alarms
> (OS-99, since deleted in OS-731) → saved queries (OS-98). Traces: merchant-api can emit
> them (OS-94, see [Traces](#traces)); they are not exported anywhere by default yet.
> Infrastructure metrics are read live from CloudWatch by Grafana Cloud (OS-733, see
> [CloudWatch metrics in Grafana Cloud](#cloudwatch-metrics-in-grafana-cloud)).

## Roles of each tool

| Tool | Answers | Status |
|---|---|---|
| **pino → Grafana Cloud Loki** | *What happened, step by step?* — searched on demand | this doc, [Log shipping](#log-shipping-to-grafana-cloud-loki) |
| **CloudWatch Logs** | the migrator's output, Fluent Bit's own output, and service logs from before the move to Loki | [Log shipping](#log-shipping-to-grafana-cloud-loki) |
| **Sentry** | *What broke, how often, since which release?* — alerts us | not yet integrated (OS-67–72) |
| **CloudWatch alarms → SNS** | *Is something down / over threshold?* — pages us | `docs/runbooks/alerts.md`, whose top note says whether paging is on |
| **OpenTelemetry traces** | *Where did the time go inside a request?* | merchant-api, storefront-api, pos-api (not the worker yet); off unless an OTLP endpoint is set — [Traces](#traces) |
| **CloudWatch metrics in Grafana Cloud** | *How busy / healthy is the infrastructure?* — CPU, memory, ALB, RDS, Redis | queried live, nothing ingested — [CloudWatch metrics in Grafana Cloud](#cloudwatch-metrics-in-grafana-cloud) |

The **correlation ID** ties them together: it's the `x-request-id` response header, the
`correlationId` field on every log line, rides on every BullMQ job, and (later) is a Sentry tag.

## The log line

In production every line is one JSON object on stdout; ECS hands it to a Fluent Bit sidecar
that ships it to Grafana Cloud Loki ([log shipping](#log-shipping-to-grafana-cloud-loki)).
In local dev the same data is pretty-printed.

```json
{
  "level": "info",
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
| `level` | pino | the name: `debug`, `info`, `warn`, `error`, `fatal` |
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
| `alert` | caller | `true` when a human must act now — a paging decision ([Event names](#event-names)) |
| `trace_id`, `span_id` | `mixin()` in `packages/logging`, from the active span | only while a sampled span is active — inside a traced request; absent at boot, in untraced services and in the worker (OS-95). The access line carries the HTTP server span's IDs |

Request-context fields (`correlationId`, `accountId`, `userId`, …) are attached automatically
from AsyncLocalStorage — **don't pass them by hand**. The middleware opens the scope with the
correlation ID; each auth guard adds the caller it resolved with `setLogContext()`, so every
later line of the request — service lines and the access line — carries it. A line logged
before the guard runs (or on a public route) has only `correlationId`.

### Access log

`requestLoggingMiddleware()` from `logging` (registered first in each API's `main.ts`) writes
one line per HTTP request when the response finishes:

```json
{"level":"warn","service":"merchant-api","correlationId":"…","context":"HTTP","event":"http.request",
 "req":{"method":"GET"},"route":"/orders/:id","res":{"statusCode":401},"responseTime":1.5,
 "msg":"GET /orders/:id 401"}
```

- `route` is the matched **template**, never the raw URL or query string (they can carry IDs
  and tokens); `null` when nothing matched. Every API runs Nest on Fastify, which reports it via
  `trackRouteTemplates()` (an `onRequest` hook) in `main.ts`.
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

`alert: true` is a paging decision — set it only when a human must act now. What alerts on
these lines, and whether paging is on, is in `docs/runbooks/alerts.md`. Find them with the
`alert="true"` query in [Tracing a bug](#tracing-a-bug).

## Levels

| Level | Use for | In prod? |
|---|---|---|
| `fatal` | process is about to exit (uncaught exception) | yes |
| `error` | a customer/merchant was failed, or a human must act (`alert: true`) | yes |
| `warn` | unexpected but handled: a retry, a 401/403/429, a degraded dependency | yes |
| `info` | business events + one access line per request | yes |
| `debug` | diagnostics while developing | no |

`LOG_LEVEL` sets the threshold: default `info` in production, `debug` elsewhere. `/health`
requests are never logged (ALB + ECS checks hit them every 15s).

## Errors

Every service's `main.ts` wires the same few things, so an error is logged once, as structured
JSON, wherever it happens, and answered with one body:

- **`useApiErrors(app)`** (`packages/errors`; storefront-api calls it from `configureApp`) — on
  the three APIs, it registers the `ValidationPipe` and **`ApiErrorFilter`**, which handles every
  exception that escapes a controller or guard. It logs the exception (the line below), then
  answers with the error envelope from [root ADR 0001](./adr/0001-api-error-envelope.md):

  ```json
  { "error": { "type": "invalid_request_error", "code": "email_taken",
               "message": "Email already in use", "param": "email",
               "doc_url": "https://ordersail.com/docs/errors/email-taken",
               "request_id": "8f0c…" } }
  ```

  - `request_id` is the request's `correlationId` (the `x-request-id` header): quote it from a
    client report and the logs and trace for that request are one query away.
  - **A 5xx body never contains internals**: no thrown message, stack or `cause`, only the
    code's generic message. The detail is in the `http.unhandled_error` line. Errors the HTTP
    layer raises itself (Fastify's `FST_*`) keep their 4xx status and message; any other error
    carrying a `statusCode` (a Stripe SDK error, say) is answered as a 500.
  - Codes come from the registry in `packages/errors/src/codes.ts`. Throw
    `new ApiException('<code>')` where a client needs to tell a case apart; a plain
    `NotFoundException` still works and gets the generic code for its status.

  The log line:

  | Status | Level | Line |
  |---|---|---|
  | 5xx, or anything that isn't an `HttpException` | `error` | `{ err, event: 'http.unhandled_error', route, status }` — with the stack |
  | 401 / 403 / 429 | `warn` | `{ event: 'http.request_rejected', route, status, reason }` — no stack |
  | other 4xx (validation, not found, 413…) | `debug` | same as above |

  `status` is the status the client got. Nest's own unstructured `ExceptionsHandler` line is
  never written, so each error shows up once. The access line for the same request is still
  written separately. Don't catch-and-rethrow just to log: throw, and let the filter log it.

  The worker serves only an internal `/health`, so it keeps `LoggingExceptionFilter` from
  `logging`: the same log line, with Nest's default response body.
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

## Log shipping to Grafana Cloud Loki

A service's stdout goes to exactly one place. ECS FireLens hands it to a Fluent Bit sidecar
(`log-router`) in the same task, which pushes each line to Grafana Cloud Loki over HTTPS. The
app is unchanged — it still just writes JSON to stdout.

| Service | Production logs are in |
|---|---|
| merchant-api, storefront-api, pos-api, worker | Grafana Cloud Loki |
| migrator | CloudWatch `/ecs/ordersail-migrator` (the CD run prints it) |

- **Wiring:** `infra/terraform/envs/production/logging.tf` and the `log_shipping` variable of
  `modules/ecs-service`. The token lives in the `ordersail/production/grafana-cloud` secret.
- **Labels:** only `service_name` and `deployment_environment`. Everything else stays in the
  line and is parsed when you query: `{service_name="merchant-api"} | json | correlationId="…"`.
  Don't add IDs as labels — every distinct value becomes its own stream.
- **Levels** are names, which Grafana detects by itself (colours, the level filter). In a
  query: `| json | level=~"error|fatal"`.
- **When lines are missing**, read Fluent Bit's own output in the CloudWatch log group
  `/ecs/ordersail-log-router` — a rejected token or an unreachable Loki only shows up there.
- The services no longer write to their CloudWatch log groups, so the Logs Insights saved
  queries see no new lines. The log-based alarms that read them (OS-99) were deleted in OS-731.

### Logs in local Grafana

`npm run up` starts a local Loki, Grafana and Fluent Bit next to Postgres and Redis. Nothing
local ever talks to Grafana Cloud.

Under `npm run dev` each service keeps pretty-printing to the terminal and also writes the
same lines as JSON to `.logs/<service>.log` (git-ignored, emptied each time the service
starts). Fluent Bit tails that folder and pushes to Loki. Open <http://localhost:3300> →
Explore:

```logql
{deployment_environment="development"} | json                                  # everything
{service_name="worker"} | json | level=~"warn|error|fatal"                     # one service, warn and up
{deployment_environment="development"} | json | correlationId="PASTE-ID"       # one request, API → worker
```

The lines, labels and queries are the same as production's; only
`deployment_environment` differs. Logs last until `npm run down`. If the containers aren't
running, the services still log to the terminal as usual.

**Production rehearsal.** The file tail above doesn't exercise how ECS hands stdout to Fluent
Bit. To check that path — before changing the Fluent Bit image or its output options — run
the real merchant-api image the way production does (`NODE_ENV=production`, JSON on stdout,
Docker's `fluentd` log driver, which is what FireLens uses):

```bash
npm run log-shipping:up     # builds the merchant-api image the first time; serves on :3020
curl -H 'x-request-id: try-me' localhost:3020/orders
npm run log-shipping:down   # stops the whole local stack, like `npm run down`
```

Its lines are labelled `deployment_environment="production-rehearsal"`, and each should be
the raw pino JSON, not a wrapper around it.

Fluent Bit's local config is `docker/fluent-bit/dev.conf`. The rehearsal's output options
mirror the ones in `modules/ecs-service`, apart from the destination (no TLS or credentials
locally): change the line-shaping keys in both places together, and keep the Fluent Bit image
tag the same in `docker-compose.yml` and the module.

## Traces

`packages/tracing` sets up OpenTelemetry for a service. The three APIs load it —
`apps/<api>/src/instrument.ts`, the first import in each `main.ts`. All three run Nest on
Fastify, so one instrumentation list covers them. The worker isn't traced yet (OS-704).

**Off unless configured.** Nothing is registered or patched unless `OTEL_EXPORTER_OTLP_ENDPOINT`
is set, so tests and CI run exactly as before. Local dev sets it to the local Tempo
([Traces in local Grafana](#traces-in-local-grafana)); production sets it from Terraform
([Traces in production](#traces-in-production-grafana-cloud)). Set it to the base URL of any
OTLP/HTTP receiver — the exporter appends `/v1/traces` — and, for a hosted backend, put its
credentials in `OTEL_EXPORTER_OTLP_HEADERS`. The app only ever reads those two standard
variables, so a local Tempo, Grafana Cloud or a collector are all just configuration.

**What a request records.** One trace per request:

```text
POST /auth/signin            HTTP server span — method, route template, status, ordersail.* IDs
└─ request                   Fastify's request span
   ├─ pg-pool.connect        waiting for a pooled connection
   └─ pg.query:SELECT …      one per query, with the SQL text
```

Every span carries `service.name` and `deployment.environment`, the same two values as the
Loki labels.

**Sampling: every trace is kept**, parent-based — OpenTelemetry's default sampler, which the
code leaves in place. Pre-launch traffic is small enough that 100% fits the Grafana Cloud free
allowance, and a sampled-out trace is exactly the one you'd want when a bug comes in. Revisit
(OS-110) when daily span volume approaches the free allowance, or when launch traffic starts.
"Parent-based" means an inbound `traceparent` header decides: a caller that sends one marked
not-sampled gets no trace (and its log lines no `trace_id`). Today no client sends one.

**The request's context is on the HTTP server span.** `packages/logging` records the log
context on it as well as on the line: `ordersail.correlation_id` when the request opens, then
whatever the auth guard resolves through `setLogContext()` — `ordersail.account_id`,
`ordersail.user_id`, and so on, one `ordersail.<snake_case>` attribute per log-context field
(`SPAN_ATTRIBUTES`). A public route has only the correlation ID. They go on the server span,
not the Fastify `request` span the guard actually runs under, so a TraceQL search on them
matches the request's root. The same rule as logs: IDs only.

Only the request's own scope writes to its span. A scope opened inside it — the Stripe
webhook's checkout-order handler, `runWithLogContext()` with the event's tenant — stamps its own
log lines but leaves the server span alone, so the public webhook route still carries only its
correlation ID.

`correlationId` is not the trace ID. It stays the user-facing ID (`x-request-id`, reused from
an inbound header or minted); the trace ID is OpenTelemetry's. Log lines carry both, the span
carries the correlation ID, so either one finds the other.

**The instrumentation list is pinned**: HTTP, Fastify, `pg`, in `createInstrumentations()`.
`instrumentations.spec.ts` fails when one is added, removed or loosened, so changing what a
traced request records is always a deliberate edit. Not traced on purpose:

- `/health` — hit every 15s per service by the ALB and ECS.
- Anything outside a request: boot-time queries, the S3 bucket check, background calls.
- Fastify's per-hook spans (cookie, CORS, helmet…).

**The same privacy rules as logs** ([Personal data & secrets](#personal-data--secrets)).
Span attributes are an **allow-list** (`ALLOWED_ATTRIBUTES` in `packages/tracing`): any key
not on it is dropped before export, so an instrumentation upgrade that starts recording
something new can't leak it. Adding a key is a deliberate edit, pinned by
`instrumentations.spec.ts`. The `ordersail.*` keys aren't listed there: the allow-list takes
them from `SPAN_ATTRIBUTES` (`logging/span-attributes`), so a new log-context field is exported
without a second edit. What that keeps out:

- the raw path and query string — the HTTP and Fastify spans both record them; only the
  route template (`http.route`) is kept
- the caller's IP address and user agent, which the access log doesn't record either
- query parameter values — the query text keeps its `$1` placeholders. A value written into
  the SQL itself (`sql.raw`, an inlined literal) would still show, so don't.
- headers and request or response bodies, which nothing records anyway

Span events have their own allow-list (`ALLOWED_EVENT_ATTRIBUTES`): a recorded exception
keeps its type, message and stack, exactly what `err` keeps in logs, and any other event
attribute is dropped. Link attributes go through `ALLOWED_ATTRIBUTES`. The same rule as
`err` in logs applies to what goes into an error message: it is exported as written, and so
is the span's error status, which carries the same message.

**On shutdown** the spans still waiting in the batch are sent before the process exits
(`installShutdownHandler`'s `afterClose`), bounded to 2s so a backend that is down can't
hold up a deploy. A crash, or an `app.close()` that throws, loses the last few seconds of
spans; the `fatal` log line still lands.

**Loading order matters.** The libraries are patched as they are loaded, so
`import './instrument'` must stay the first line of `main.ts`. If traces show the HTTP span
but no `pg` spans (or nothing at all), check that first.

### Traces in local Grafana

`npm run up` also starts a local Tempo. Each API's `.env.example` points
`OTEL_EXPORTER_OTLP_ENDPOINT` at it (`http://localhost:4318`); an existing `apps/<api>/.env`
created before that line was there needs it added by hand, since `npm run setup` never
overwrites. Under `npm run dev`, open <http://localhost:3300> → Explore → **Tempo**, then
**Search**, or switch to **TraceQL**:

```traceql
{ resource.service.name = "merchant-api" }                          # every trace
{ resource.service.name = "merchant-api" && span.http.route = "/orders/:id" }
{ resource.service.name = "merchant-api" && duration > 200ms }       # slow requests
{ span.db.system.name = "postgresql" && duration > 50ms }            # slow queries
```

Traces show up a few seconds after the request (the exporter batches every 5s) and last
until `npm run down`. If Tempo isn't running, merchant-api still starts and serves as usual;
the spans are dropped, and stopping the service can take up to 2s longer while the exporter
gives up. To turn tracing off locally, comment the line out or leave it empty
(`OTEL_EXPORTER_OTLP_ENDPOINT=`).

Traces and logs link both ways in the local Grafana (`docker/grafana/provisioning/datasources/`):

- **log → trace**: expand a Loki line with a `trace_id`; the **View trace** link next to the
  field opens that trace in Tempo.
- **trace → logs**: in a trace, the logs icon on a span (or **Logs for this span**) runs a Loki
  query for that service's lines carrying the trace ID — the access line plus every service
  line of the request.

Grafana Cloud has the same two links, set up by hand ([Traces in production](#traces-in-production-grafana-cloud)).

### Traces in production (Grafana Cloud)

merchant-api, storefront-api and pos-api export straight from their OpenTelemetry SDKs to
Grafana Cloud's OTLP gateway — no collector sidecar (OS-97, OS-703). One switch and one
`traces:write` token cover all three. The worker isn't traced yet (OS-704).

- **Endpoint**: `otel_exporter_otlp_endpoint` in `infra/terraform/envs/production/terraform.tfvars`,
  the gateway's base URL ending in `/otlp`. Unset, the APIs' task definitions have no
  `OTEL_*` variables and tracing is off (`infra/terraform/envs/production/tracing.tf`).
- **Credentials**: the `OTEL_EXPORTER_OTLP_HEADERS` key of the `ordersail/production/grafana-cloud`
  secret, mapped into the app container's environment (the same secret's `LOKI_TOKEN` never
  is: it's only in the log configuration, which the log router reads). The value is the whole
  header in the OTLP env format, `Authorization=Basic%20<base64("<instance ID>:<token>")>` — the
  `%20` is the space, and the token is its own access-policy token with `traces:write` only
  (Loki's has `logs:write`). The live secret predates the key, and Terraform never updates it
  (`ignore_changes`), so the key has to be added by hand; `npm run verify:contracts` refuses a
  deploy while it's missing or empty.
- **Find a trace**: Grafana Cloud → Explore → the Tempo data source:

  ```traceql
  { resource.service.name = "merchant-api" && resource.deployment.environment = "production" }
  { span.ordersail.correlation_id = "PASTE-CORRELATION-ID" }
  ```

  Or start from a log line: expand it and follow **View trace**.

**The links, set up by hand** in Grafana Cloud → Connections → Data sources (the local
`docker/grafana/provisioning/datasources/` files are the reference; in the UI it's a single `$`):

- Loki data source → **Derived fields**: name `trace_id`, regex `"trace_id":"(\w+)"`, internal
  link to the Tempo data source, query `${__value.raw}`, label **View trace**.
- Tempo data source → **Trace to logs**: the Loki data source, tag `service.name` → `service_name`,
  span start shift `-1m`, end shift `1m`, custom query
  `{${__tags}} |= "${__trace.traceId}" | json | trace_id = "${__trace.traceId}"`.

**A failing export never fails a request.** Spans are sent in the background, in batches
(every 5s, or every 512 spans). A batch that can't be delivered — a rejected token, an
unreachable gateway, after the exporter's own retries for the latter — is dropped, and
merchant-api logs one `warn` line for it, `event: "tracing.export_failed"`, `context:
"OpenTelemetry"`, with `err.code` the HTTP status when there was one. One per batch, never one
per request, and `warn` rather than `error`: the service is fine, only its traces are lost, so
it wouldn't count toward an error-volume alert. Other OpenTelemetry warnings (spans dropped because the
queue filled) log as `tracing.sdk_warned`, and an instrumentation's own error (an HTTP or `pg`
hook) as `tracing.sdk_errored` — neither means export is failing. `packages/logging` registers
this as OpenTelemetry's diag logger in `configureLogging()`; only text and an `Error` reach the
line, never other arguments (`pg` can pass query parameter values).

**Usage** — grafana.com → your organization → **Usage** (or the stack's **Billing / Usage**
dashboard in Grafana Cloud): traces are counted in GB ingested per month, against the free
allowance. Check it after the first day with export on, and again before launch (OS-110).

**Traces missing in production** — check in this order:

1. Is `otel_exporter_otlp_endpoint` set, applied, and deployed? The running task definition
   should list `OTEL_EXPORTER_OTLP_ENDPOINT` (ECS console → the task → Environment).
2. `npm run verify:contracts` — an empty or missing `OTEL_EXPORTER_OTLP_HEADERS` key fails it.
3. merchant-api's logs: `{service_name="merchant-api"} | json | event="tracing.export_failed"`.
   `err.code` `401`/`403` is the token (wrong value, wrong scope, or the header not in
   `Authorization=Basic%20…` form); a timeout or `ECONNREFUSED` is the network or the endpoint.
4. Traces with an HTTP span but no `pg` spans: the loading order (above).
5. A `/health` request: never traced, on purpose.

## CloudWatch metrics in Grafana Cloud

Infrastructure metrics — ECS CPU and memory (per service in `AWS/ECS`, per task in
`ECS/ContainerInsights`), ALB, RDS, ElastiCache, SES — stay in CloudWatch. Grafana Cloud's **CloudWatch data source** queries them live, so they cost
none of the free tier's 10k active series and the dashboards read the same numbers the alarms
do. Production only: the local Grafana has no AWS credentials.

Grafana Cloud signs in with **Grafana Assume Role**: Grafana's AWS account assumes the
`ordersail-grafana-cloudwatch` role (`infra/terraform/envs/production/grafana-cloudwatch.tf`),
and only when it presents the external ID Grafana generated for our stack. No AWS keys live in
Grafana. The role is read-only: CloudWatch metrics, alarm configuration, state and history,
Contributor Insights rule reports, the region list, and `tag:GetResources`, which lists the ARN
and tags of every tagged resource in the account. It can't read logs, read what's inside any
resource (database rows, S3 objects, secrets), or change anything.

**Setting it up** (once; redo only if the stack is recreated):

1. grafana.com → your stack → **Connections → Data sources → Add new data source →
   CloudWatch**. Name it `CloudWatch`.
2. **Authentication provider: Grafana Assume Role.** The Settings tab then shows Grafana's AWS
   account ID and our **external ID**. Leave the page open.
3. Put both in `infra/terraform/envs/production/terraform.tfvars`:
   `grafana_aws_account_id` and `grafana_cloudwatch_external_id`. Neither is secret. Plan and
   apply from an up-to-date `main`.
4. `terraform output -raw grafana_cloudwatch_role_arn` → paste into **Assume Role ARN**.
   **Default region:** `us-east-1`. Leave **External ID** as Grafana filled it.
5. **Save & test.** Then check in **Explore**: namespace `AWS/ECS`, metric `CPUUtilization`
   (percent), dimensions `ClusterName = ordersail` and `ServiceName = ordersail-merchant-api`.
   It returns points whenever tasks are running. A parked environment has no tasks, so no
   data, and that's expected.
6. Confirm the role reads nothing else. Every action below should come back `implicitDeny`:

   ```bash
   aws iam simulate-principal-policy \
     --policy-source-arn "$(terraform -chdir=infra/terraform/envs/production output -raw grafana_cloudwatch_role_arn)" \
     --action-names logs:StartQuery logs:FilterLogEvents s3:GetObject secretsmanager:GetSecretValue rds:DescribeDBInstances \
     --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output table
   ```

**Dashboards:** **Ordersail → Infrastructure (CloudWatch)** shows ECS CPU and memory per
service, running vs desired tasks, ALB requests, latency, errors and host health per target
group, and RDS and Redis. It's managed as code in `infra/terraform/grafana/dashboards/infra.json`
(OS-91). See `infra/terraform/README.md` → "`grafana/` — Grafana Cloud as code".

**Cost:** CloudWatch bills `GetMetricData` by metrics requested (about $0.01 per 1,000). Keep
dashboard refresh at **1m or slower**, never 5s. While the environment is parked (OS-379),
Container Insights is off and its panels show gaps, which is expected.

**If the test fails:** "not authorized to perform sts:AssumeRole" means the external ID or
account ID in tfvars doesn't match the Settings tab, or the apply hasn't run. An
`AccessDenied` on a specific action means the panel needs a permission the role doesn't have;
add it to `grafana-cloudwatch.tf` deliberately rather than widening to `cloudwatch:*`.

## Tracing a bug

**Find the correlation ID**

- From the browser: the `x-request-id` response header in devtools (readable from JS too).
- From a Sentry issue: the `correlation_id` tag — *pending: no Sentry integration yet (OS-67, OS-72)*.
- From an order or job: search by `orderId` / `jobId` first, then read `correlationId` off the line.

**Local dev** — the apps log to the terminal running `npm run dev` (`npm run logs` only
follows the Docker infra containers). To search, use the local Grafana at
<http://localhost:3300> → Explore ([Logs in local Grafana](#logs-in-local-grafana)):

```logql
{deployment_environment="development"} | json | correlationId="0b7e6c1e-2f7a-4c1a-9a55-3f0f1b1d2c3e"
```

Or grep the same lines on disk: `grep 0b7e6c1e .logs/*.log`.

**From a log line to its trace (local dev, merchant-api)** — any line of a traced request
carries `trace_id`. Expand it in Explore and follow **View trace**: the request's spans, with
every query and its timing. From a trace back to its lines, use the logs link on any span
([Traces in local Grafana](#traces-in-local-grafana)). With only a correlation ID, TraceQL
finds the trace directly:

```traceql
{ span.ordersail.correlation_id = "0b7e6c1e-2f7a-4c1a-9a55-3f0f1b1d2c3e" }
{ span.ordersail.account_id = 42 && duration > 500ms }               # one tenant's slow requests
```

**Production** — Grafana Cloud → Explore, Loki data source. A merchant-api line carries
`trace_id`, and **View trace** opens the request's spans in Tempo; with only a correlation ID,
the TraceQL above works there too ([Traces in production](#traces-in-production-grafana-cloud)).

```logql
{deployment_environment="production"} | json | correlationId="PASTE-CORRELATION-ID"   # one request, API → worker
{deployment_environment="production"} | json | orderId=1234                            # every line naming an order
{deployment_environment="production"} | json | accountId=42                            # one tenant
{deployment_environment="production"} | json | level=~"error|fatal"                    # errors, all services
{deployment_environment="production"} | json | alert="true"                            # lines a human must act on
```

Add `service_name="worker"` (or another service) inside the braces to narrow it.

**Production, before the move to Loki (2026-10-01)** — older lines are still in CloudWatch
until they age out (30 days). Logs Insights → **Saved queries** → the `ordersail/` folder
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
| `ordersail/Alerts` | `alert: true` lines | — |
| `ordersail/Slow requests` | access lines over 1s: count, p95, max by `route` | — |
| `ordersail/4xx-5xx by route` | failed requests by `route` and status | — |

The query text lives in Terraform only; change it there and apply. Writing your own: filter on
booleans with `= 1`, not `= true` (Logs Insights exposes JSON booleans as 1/0), and nested
fields with a dot (`res.statusCode`, `err.message`).
