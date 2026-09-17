import { env } from "./env"; // validates process.env before anything else loads
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { Logger, configureLogging, runWithCorrelationId } from "logging";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppModule } from "./app.module";
import { createSwaggerConfig } from "./swagger.config";

async function bootstrap() {
  configureLogging({
    service: "pos-api",
    nodeEnv: env.NODE_ENV,
    level: env.LOG_LEVEL,
  });
  const app = await NestFactory.create(AppModule, {
    logger: new Logger(),
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const header = req.headers["x-request-id"];
    const correlationId =
      (Array.isArray(header) ? header[0] : header) || randomUUID();
    res.setHeader("x-request-id", correlationId);
    runWithCorrelationId(correlationId, next);
  });

  // the POS client is a native app, not a browser — CORS is only relevant
  // for the Swagger UI and any web-based tooling
  app.enableCors({
    origin: env.POS_WEB_URL ?? true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["content-type", "x-pos-device-token", "x-request-id"],
  });

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  SwaggerModule.setup("swagger", app, document, {
    jsonDocumentUrl: "swagger/json",
  });

  await app.listen(env.PORT);
}
bootstrap();
