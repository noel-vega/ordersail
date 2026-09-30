import { env } from './shared/env'; // validates process.env before anything else loads
import { initSentry } from 'observability';

// Sentry error tracking (docs/observability.md → Error tracking). Imported
// first by main.ts: Sentry must load before Nest and fastify to hook them.
// Unset SENTRY_DSN (local dev, tests) → a no-op.
initSentry({
  service: 'merchant-api',
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
  release: env.SENTRY_RELEASE,
});
