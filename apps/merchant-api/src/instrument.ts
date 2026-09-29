import { env } from './shared/env'; // validates process.env before anything else loads
import { initSentry } from 'observability';

// Imported first by main.ts: Sentry has to initialise before Nest, Fastify and
// the HTTP stack are loaded so its instrumentation can hook them. Off unless
// SENTRY_DSN is set.
initSentry({
  service: 'merchant-api',
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  release: env.SENTRY_RELEASE,
});
