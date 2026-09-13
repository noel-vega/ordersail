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
import { CorsOriginsService } from './modules/cors-origins/cors-origins.service';

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

  // customer signin now sets an httpOnly refresh cookie, so this can no
  // longer be a wildcard origin like it used to be. Storefronts can be
  // hosted on any merchant-owned domain, so the allowed set is dynamic
  // (registered storefront_origins rows), not one hardcoded value — see
  // CorsOriginsService. Note: a CORS preflight never carries the actual
  // x-app-key value, only Origin, so this can only confirm an origin is
  // registered by *some* account, not that it belongs to *this* request's
  // account — that cross-check happens separately (OS-438).
  const corsOrigins = app.get(CorsOriginsService);
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // no Origin header — not a browser CORS request (curl, health checks,
      // server-to-server); nothing for CORS to gate
      if (!origin) return callback(null, true);
      callback(null, corsOrigins.isAllowed(origin));
    },
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
