import { parseEnv, z } from 'config';
import { LOG_LEVELS } from 'logging';

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
    // becomes a compliance requirement. Must be real hex, not just 64
    // characters — Buffer.from(str, 'hex') silently truncates at the first
    // invalid character rather than throwing, so a non-hex value would
    // otherwise pass startup validation and only fail later, deep inside
    // createCipheriv/createDecipheriv.
    MFA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
    MERCHANT_WEB_URL: z.url().default('http://localhost:5000'),

    // WebAuthn relying-party identity (OS-485). All optional — derived from
    // MERCHANT_WEB_URL when unset, which is already correct in every
    // environment. Override only to change the RP ID deliberately, since it
    // is baked into every credential ever issued and cannot be migrated.
    // See identity/auth/webauthn.config.ts.
    WEBAUTHN_RP_ID: z.string().min(1).optional(),
    // comma-separated; the browser origins allowed to complete a ceremony
    WEBAUTHN_ORIGINS: z.string().min(1).optional(),
    // shown by the authenticator / password manager when saving a passkey
    WEBAUTHN_RP_NAME: z.string().min(1).default('OrderSail'),

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
    // unset → info in production, debug elsewhere (see docs/observability.md)
    LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  }),
);
