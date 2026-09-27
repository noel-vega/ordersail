import { z } from 'config';
import { LOG_LEVELS } from 'logging';

// The env contract, split out of env.ts so it can be read without parsing
// process.env (env.ts parses on import). env.mappings.spec.ts checks that
// every key here is mapped in the production task def (OS-655).
export const envSchema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().default(3001),
  CUSTOMER_JWT_SECRET: z.string().min(1),
  // refresh tokens rotate on every use with reuse detection (OS-457), so
  // the absolute TTL is a secondary defense — 7d keeps a customer signed
  // in for a reasonable stretch without forcing frequent re-logins
  CUSTOMER_REFRESH_TOKEN_TTL: z.string().default('7d'),

  // one platform-owned Stripe/Shippo account, shared with merchant-api.
  // The checkout webhook moved to merchant-api (M9) — no webhook secret here.
  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  SHIPPO_API_KEY: z.string().min(1),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),

  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  // unset → info in production, debug elsewhere (see docs/observability.md)
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
});
