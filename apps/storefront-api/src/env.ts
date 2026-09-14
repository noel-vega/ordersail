import { parseEnv, z } from 'config';

// Parsed once, on import. `main.ts` imports this module first so a bad env
// fails before Nest wires anything up. Schema mirrors the old `?? default`
// fallbacks and `!` assertions 1:1 — no behaviour change for a valid env.
export const env = parseEnv(
  'storefront-api',
  z.object({
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
  }),
);
