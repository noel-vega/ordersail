// Must stay the first import: tracing patches http, express and pg as they
// are loaded, so it has to run before anything below requires them.
import './instrument';
import { env } from './env'; // validates process.env before anything else loads
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import {
  Logger,
  LoggingExceptionFilter,
  configureLogging,
  exitOnFatal,
  installProcessHandlers,
  installShutdownHandler,
  requestLoggingMiddleware,
} from 'logging';
import { shutdownTracing } from 'tracing';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { createSwaggerConfig } from './swagger.config';

async function bootstrap() {
  configureLogging({
    service: 'storefront-api',
    nodeEnv: env.NODE_ENV,
    level: env.LOG_LEVEL,
  });
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: new Logger(),
  });
  app.useGlobalFilters(new LoggingExceptionFilter(app.getHttpAdapter()));
  // spans still in the batch are sent before the process exits on a deploy
  installShutdownHandler(app, { afterClose: shutdownTracing });

  // correlation ID (reused from a well-formed inbound x-request-id or minted)
  // + one access log line per request — see docs/observability.md
  app.use(requestLoggingMiddleware());

  // /v1 prefix, validation, cookies — shared with the OpenAPI generator and
  // the SDK contract spec
  configureApp(app);

  // Storefronts can be hosted on any merchant-owned domain, so there's no
  // fixed origin (or DB-backed allowlist) to gate here — CORS preflight
  // never carries x-app-key, only Origin, so it can never tell which
  // account an origin needs to belong to (that's a coarse check at best).
  // The real tenant-scoping check — this origin must belong to *this*
  // request's account, not just be registered by someone — happens once
  // x-app-key resolves an accountId, in AppKeyGuard. CORS itself just
  // reflects whatever Origin was sent.
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'x-app-key',
      'x-cart-token',
      'authorization',
      'x-request-id',
    ],
    exposedHeaders: ['x-request-id'],
  });

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  SwaggerModule.setup('swagger', app, document, {
    jsonDocumentUrl: 'swagger/json',
  });

  await app.listen(env.PORT);
}

// before bootstrap() so a crash anywhere — boot included — ends in one fatal
// JSON line instead of a raw stderr trace (docs/observability.md → Errors)
installProcessHandlers();
bootstrap().catch((err) => exitOnFatal(err, 'app.boot_failed'));
