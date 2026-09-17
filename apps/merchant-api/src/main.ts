import { env } from './shared/env'; // validates process.env before anything else loads
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
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
  requestLoggingMiddleware,
  setRequestRoute,
} from 'logging';
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
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  // correlation ID (reused from a well-formed inbound x-request-id or minted)
  // + one access log line per request — see docs/observability.md. Fastify
  // doesn't put the matched route on the raw request, so report the template
  // from its onRequest hook for the access line.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, _reply, done) => {
      setRequestRoute(request.raw, request.routeOptions.url);
      done();
    });
  app.use(requestLoggingMiddleware());

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
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
bootstrap();
