import { z } from 'config';
import { LOG_LEVELS } from 'logging';

// The env contract, split out of env.ts so it can be read without parsing
// process.env (env.ts parses on import). env.mappings.spec.ts checks that
// every key here is mapped in the production task def (OS-655).
export const envSchema = z
  .object({
    PORT: z.coerce.number().default(3003),
    DATABASE_URL: z.url(),

    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().default(6379),

    // `ses` in production: the SES API with the task role, no credentials
    // (OS-658). `smtp` is local dev's Mailpit, which takes no auth.
    EMAIL_TRANSPORT: z.enum(['smtp', 'ses']).default('smtp'),
    EMAIL_FROM: z.string().default('Ordersail <no-reply@ordersail.local>'),
    // read only when EMAIL_TRANSPORT=smtp
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().default(1025),

    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    // unset → info in production, debug elsewhere (see docs/observability.md)
    LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  })
  // the smtp defaults point at localhost — a production worker left on them
  // would boot fine and fail every email, so refuse to boot instead
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.EMAIL_TRANSPORT === 'ses',
    {
      path: ['EMAIL_TRANSPORT'],
      message: 'must be "ses" in production',
    },
  );
