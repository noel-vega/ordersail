import { parseEnv, z } from 'config';
import { LOG_LEVELS } from 'logging';

// Parsed once, on import. `main.ts` imports this module first so a bad env
// fails before Nest wires anything up. Schema mirrors the old `?? default`
// fallbacks 1:1 — no behaviour change for a valid env.
export const env = parseEnv(
  'worker',
  z.object({
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
  }),
);
