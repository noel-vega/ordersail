import { env } from './shared/env'; // validates process.env before anything else loads
import { randomUUID } from 'node:crypto';
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
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CorrelatedLogger, runWithCorrelationId } from 'logging';
import { createSwaggerConfig } from './swagger.config';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy: 1 trusts exactly one hop of X-Forwarded-For — the ALB,
    // which is the only way to reach this task (private subnet). This is
    // what makes req.ip resolve to the real client IP instead of the ALB's,
    // which the throttler guard keys rate limits on.
    new FastifyAdapter({ trustProxy: 1 }),
    {
      rawBody: true,
      logger: new CorrelatedLogger(undefined, {
        json: env.NODE_ENV === 'production',
      }),
    },
  );
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  // reuses an inbound x-request-id if the caller already set one, otherwise
  // mints a fresh one — either way it's echoed back and threaded through
  // every log line this request produces, including ones emitted from
  // BullMQ jobs it enqueues. FastifyAdapter's use() runs this as connect-style
  // middleware (raw Node req/res), same as storefront-api's Express version.
  app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const header = req.headers['x-request-id'];
    const correlationId =
      (Array.isArray(header) ? header[0] : header) || randomUUID();
    res.setHeader('x-request-id', correlationId);
    runWithCorrelationId(correlationId, next);
  });

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  SwaggerModule.setup('swagger', app, document, {
    jsonDocumentUrl: 'swagger/json',
  });

  app.enableCors({
    origin: env.MERCHANT_WEB_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
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
