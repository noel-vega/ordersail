import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { writeFileSync } from 'fs';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { createSwaggerConfig } from '../src/swagger.config';

async function generate() {
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
    logger: false,
  });

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  writeFileSync('./openapi.json', JSON.stringify(document, null, 2));

  await app.close();
}
generate();
