import { env } from './env'; // validates process.env before anything else loads
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { CorrelatedLogger, runWithCorrelationId } from 'logging';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppModule } from './app.module';
import { createSwaggerConfig } from './swagger.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: new CorrelatedLogger(undefined, {
      json: env.NODE_ENV === 'production',
    }),
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  // reuses an inbound x-request-id if the caller already set one (useful
  // once there's a frontend/proxy assigning them), otherwise mints a fresh
  // one — either way it's echoed back and threaded through every log line
  // this request produces, including ones emitted from BullMQ jobs it enqueues
  app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const header = req.headers['x-request-id'];
    const correlationId =
      (Array.isArray(header) ? header[0] : header) || randomUUID();
    res.setHeader('x-request-id', correlationId);
    runWithCorrelationId(correlationId, next);
  });

  app.use(cookieParser());

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
    ],
  });

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  SwaggerModule.setup('swagger', app, document, {
    jsonDocumentUrl: 'swagger/json',
  });

  await app.listen(env.PORT);
}
bootstrap();
