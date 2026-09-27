import { z } from 'config';
import { LOG_LEVELS } from 'logging';

// The env contract, split out of env.ts so it can be read without parsing
// process.env (env.ts parses on import). env.mappings.spec.ts checks that
// every key here is mapped in the production task def (OS-655).
export const envSchema = z.object({
  PORT: z.coerce.number().default(3003),
  DATABASE_URL: z.url(),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),

  // local Mailpit takes no auth; a real relay (SES) needs SMTP_USER/PASS
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_FROM: z.string().default('Ordersail <no-reply@ordersail.local>'),
  SMTP_SECURE: z.string().optional(), // '=== true' checked at the call site
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  // unset → info in production, debug elsewhere (see docs/observability.md)
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
});
