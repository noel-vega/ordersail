import { z } from "config";
import { LOG_LEVELS } from "logging";

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
});
