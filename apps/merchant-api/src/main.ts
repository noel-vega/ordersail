// Must stay the first import: tracing patches http, fastify and pg as they
// are loaded, so it has to run before anything below requires them.
import './instrument';
import { env } from './shared/env'; // validates process.env before anything else loads
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { SwaggerModule } from '@nestjs/swagger';
import {
  Logger,
  configureLogging,
  exitOnFatal,
  installProcessHandlers,
  installShutdownHandler,
  requestLoggingMiddleware,
  trackRouteTemplates,
} from 'logging';
import { useApiErrors, withErrorResponses } from 'errors';
import { shutdownTracing } from 'tracing';
import { shutdownMetrics } from 'metrics';
import { createSwaggerConfig } from './swagger.config';

async function bootstrap() {
  configureLogging({
    service: 'merchant-api',
    nodeEnv: env.NODE_ENV,
    level: env.LOG_LEVEL,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy: 1 trusts exactly one hop of X-Forwarded-For — the ALB,
    // which is the only way to reach this task (private subnet). This is
    // what makes req.ip resolve to the real client IP instead of the ALB's,
    // which the throttler guard keys rate limits on.
    new FastifyAdapter({ trustProxy: 1 }),
    {
      rawBody: true,
      logger: new Logger(),
    },
  );
  // validation, and the one error body every API returns (ADR 0001)
  useApiErrors(app);
  // spans still in the batch are sent before the process exits on a deploy
  installShutdownHandler(app, {
    // final trace and metric exports, in parallel, each bounded (2s)
    afterClose: async () => {
      await Promise.all([shutdownTracing(), shutdownMetrics()]);
    },
  });

  // correlation ID (reused from a well-formed inbound x-request-id or minted)
  // + one access log line per request — see docs/observability.md. The route
  // template comes from Fastify's onRequest hook, so register that first.
  trackRouteTemplates(app.getHttpAdapter().getInstance());
  app.use(requestLoggingMiddleware());

  const document = withErrorResponses(
    SwaggerModule.createDocument(app, createSwaggerConfig()),
  );
  SwaggerModule.setup('swagger', app, document, {
    jsonDocumentUrl: 'swagger/json',
  });

  app.enableCors({
    origin: env.MERCHANT_WEB_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    // lets merchant-web read the request ID back (e.g. for an error report)
    exposedHeaders: ['x-request-id'],
  });
  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    // CSP is left off this pass: merchant-api mostly serves JSON to merchant-web
    // (a separate origin, unaffected by CSP), but it also serves the Swagger UI
    // at /swagger, which relies on inline scripts helmet's default CSP would
    // break. Revisit with a scoped policy if Swagger UI needs hardening later.
    contentSecurityPolicy: false,
    // merchant-web calls this API cross-origin with credentials; the default
    // 'same-origin' policy would make browsers reject those responses outright.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    strictTransportSecurity: {
      maxAge: 63072000,
      includeSubDomains: true,
      preload: true,
    },
    xFrameOptions: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  // Fastify defaults to binding 'localhost' (loopback only) when no host is given — fine for
  // local dev (same machine), but unreachable from the ALB in ECS, which connects to the
  // task's real VPC IP, not loopback.
  await app.listen(env.PORT, '0.0.0.0');
}

// before bootstrap() so a crash anywhere — boot included — ends in one fatal
// JSON line instead of a raw stderr trace (docs/observability.md → Errors)
installProcessHandlers();
bootstrap().catch((err) => exitOnFatal(err, 'app.boot_failed'));
