import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { writeFileSync } from 'fs';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { createSwaggerConfig } from '../src/swagger.config';

async function generate() {
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  // so the document's paths carry the /v1 prefix the running app serves
  configureApp(app);

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  writeFileSync('./openapi.json', JSON.stringify(document, null, 2));

  await app.close();
  // app.close() doesn't close the ioredis connections AppModule builds itself
  // (BullModule's shared one and HealthService's), so the event loop stays
  // alive after the file is already written. This is a one-shot script, not a
  // long-running service — force-exit instead of waiting on a graceful
  // shutdown nothing depends on.
  process.exit(0);
}
generate();
