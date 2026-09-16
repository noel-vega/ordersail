import type {} from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'fs';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from 'src/app.module';
import { createSwaggerConfig } from 'src/swagger.config';

async function generate() {
  const app = await NestFactory.create(AppModule, { logger: false });

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  writeFileSync('./openapi.json', JSON.stringify(document, null, 2));

  await app.close();
  // app.close() doesn't fully tear down BullMQ's raw ioredis connections
  // (a known Nest+BullMQ gotcha), so the event loop stays alive for minutes
  // after the file is already written. This is a one-shot script, not a
  // long-running service — force-exit instead of waiting on a graceful
  // shutdown nothing depends on.
  process.exit(0);
}
generate();
