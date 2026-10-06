---
status: accepted
---

# Telemetry goes through one Grafana Alloy gateway, and the in-app allow-lists stay

Every signal a service emits passes through a single Grafana Alloy instance, which forwards it
to the backend:

- **Traces and metrics:** services export OTLP to Alloy, never straight to Tempo, Prometheus or
  Mimir.
- **Logs:** Fluent Bit still reads each service's stdout and pushes to Alloy on the Loki push
  API, never straight to Loki.

Alloy is the only component that knows where the backends are, and in production the only one
holding Grafana Cloud credentials. Services know one OTLP endpoint and nothing else.

```text
            ┌── OTLP :4318 ──────────────┐            ┌─> Tempo       (traces)
services ───┤                            ├─> Alloy ───┼─> Prometheus / Mimir (metrics)
            └─ stdout → Fluent Bit ──────┘  (:3100,   └─> Loki        (logs)
                       Loki push API         Loki push)
```

**Local dev (`npm run up`) runs it this way as of OS-734 and OS-738.** Production follows in
milestone M3b: the Alloy service (OS-739), traces and metrics cut over (OS-740), logs cut over
(OS-741). Until then, production services and FireLens sidecars still export to Grafana Cloud
directly. The local *production rehearsal* deliberately does the same, because it mirrors the
live FireLens options.

## Why a gateway

- **One exit point and one credential.** Today each API's task definition carries the OTLP
  auth header, and each FireLens sidecar the Loki token. Behind Alloy, only Alloy holds them.
- **The backend is configuration.** Services speak plain OTLP, and Fluent Bit speaks the Loki
  push API. Moving a signal to another backend changes Alloy's config, not the services. This
  also keeps the contract language-neutral, in case an API leaves NestJS.
- **Central processing, where it belongs:**
  - relabelling, and dropping labels that would cost too many series
  - span metrics generated from traces (OS-742)
  - tail sampling, which can't be done inside a service
- **Buffering and retries** when a backend is slow, instead of each service dropping data.
- **Local dev matches production.** One endpoint, routed by signal: the same shape we deploy.

## Considered and rejected

- **Each service exports straight to each backend** (the starting point). It's simple, but
  every service needs every endpoint and credential. It can't do tail sampling, span metrics or
  central relabelling, and it needs per-signal endpoints the moment traces and metrics go to
  different places.
- **Per-signal endpoints locally instead of Alloy** (traces → Tempo, metrics → Prometheus).
  It's smaller, but it's a local topology that production won't have. Rejected on 2026-10-06 in
  favour of matching production now.
- **An Alloy sidecar in every task.** It avoids a shared failure point, but it's a container
  per task and the config is repeated N times. For four services, one gateway is simpler.
- **Fluent Bit's `opentelemetry` output for logs.** It would make logs OTLP like the other
  signals. But it turns the raw pino line into an OTLP log record, which changes what Loki
  stores and breaks the saved queries and trace ↔ log links that match on the raw JSON. The
  Loki push API (`loki.source.api`) passes each line and its labels through unchanged.

## Consequences

- **A shared failure point.** If Alloy is down, logs, traces and metrics all go dark together.
  That's acceptable because infra alerting stays on CloudWatch, which AWS emits whether or not
  our pipeline works (the alerting split, OS-731/OS-732). Alloy's own logs go to CloudWatch,
  never through itself.
- **The in-app allow-lists stay.** Span attributes (`packages/tracing`), metric attributes
  (`packages/metrics`) and the `err` serializer and redaction (`packages/logging`) still run
  inside the process. Personal data is scrubbed before it leaves the service. Alloy may add
  relabelling, but it's a second layer, never the only one.
- **The log line is a contract.** Loki stores the raw pino JSON with only `service_name` and
  `deployment_environment` as labels. A gateway change that alters either is a breaking
  change.
  - `loki.source.api` runs with `use_incoming_timestamp = true`; its default would restamp
    every line with the time Alloy received it.
  - Verified locally on 2026-10-06: lines byte-identical, indexed labels exactly those two, and
    the trace → logs query still matches.
- **Cost:** one always-on Fargate task in production (about $9–10/mo while the environment is
  up; it parks with it).
