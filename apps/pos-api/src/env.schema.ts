import { z } from "config";
import { LOG_LEVELS } from "logging";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

// The env contract, split out of env.ts so it can be read without parsing
// process.env (env.ts parses on import). env.mappings.spec.ts checks that
// every key here is mapped in the production task def (OS-655).
export const envSchema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().default(3004),
  // origin of any browser tooling that calls this API; the POS itself is native
  POS_WEB_URL: z.url().optional(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // unset → info in production, debug elsewhere (see docs/observability.md)
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),

  // OpenTelemetry trace export. Read by packages/tracing (src/instrument.ts)
  // before this schema is parsed, and by the OTLP exporter itself; listed here
  // so they are part of the env contract. Unset or empty → tracing is off,
  // matching packages/tracing, which treats an empty endpoint as unset.
  // Base URL only — the exporter appends /v1/traces.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    emptyToUndefined,
    z.url().optional(),
  ),
  // comma-separated key=value pairs, e.g. the Authorization header for a
  // hosted backend — a secret
  OTEL_EXPORTER_OTLP_HEADERS: z.preprocess(
    emptyToUndefined,
    z.string().optional(),
  ),
  // the standard OTel switch, read by packages/metrics: `none` keeps metrics
  // off even with the endpoint set, so traces and metrics are turned on
  // separately. Unset → metrics follow the endpoint. Production sets it from
  // Terraform's metrics_export_enabled (envs/production/metrics.tf).
  OTEL_METRICS_EXPORTER: z.preprocess(
    emptyToUndefined,
    z.enum(["otlp", "none"]).optional(),
  ),
});
