import { parseEnv, z } from 'config';

// Parsed once, on import. `main.ts` imports this module first so a bad env
// fails before Nest wires anything up. Schema mirrors the old `?? default`
// fallbacks and `!` assertions 1:1 — no behaviour change for a valid env.
export const env = parseEnv(
  'merchant-api',
  z.object({
    DATABASE_URL: z.url(),
    STAFF_JWT_SECRET: z.string().min(1),
    // AES-256-GCM key for TOTP secrets at rest (OS-316) — 32 bytes, hex
    // encoded. App-level static key for now, same convention as
    // STAFF_JWT_SECRET; revisit with KMS envelope encryption if that
    // becomes a compliance requirement.
    MFA_ENCRYPTION_KEY: z.string().length(64),
    MERCHANT_WEB_URL: z.url().default('http://localhost:5000'),

    // one platform-owned Stripe/Shippo account, shared with storefront-api
    STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
    // the one Stripe Dashboard event destination → POST /webhooks/stripe
    // (account.updated + checkout.session.*); see StripeWebhookController
    STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
    SHIPPO_API_KEY: z.string().min(1),

    // MinIO locally; real S3 in prod, where creds come from the ECS task role
    // (so keys stay optional) and the endpoint is the AWS default
    MINIO_ENDPOINT: z.url().default('http://localhost:9000'),
    MINIO_ACCESS_KEY: z.string().optional(),
    MINIO_SECRET_KEY: z.string().optional(),
    MINIO_BUCKET: z.string().default('ordersail-product-images'),
    MINIO_PUBLIC_BASE_URL: z
      .url()
      .default('http://localhost:9000/ordersail-product-images'),
    // tri-state: unset -> SDK default, 'true'/'false' -> explicit (coerced in storage.service)
    MINIO_FORCE_PATH_STYLE: z.string().optional(),

    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().default(6379),

    PORT: z.coerce.number().default(3000),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
  }),
);
