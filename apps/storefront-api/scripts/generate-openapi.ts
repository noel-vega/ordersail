import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'fs';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { createSwaggerConfig } from '../src/swagger.config';

async function generate() {
  const app = await NestFactory.create(AppModule, { logger: false });
  // so the document's paths carry the /v1 prefix the running app serves
  configureApp(app);

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  writeFileSync('./openapi.json', JSON.stringify(document, null, 2));

  await app.close();
}
generate();
