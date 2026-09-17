import { env } from "./env"; // validates process.env before anything else loads
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { Logger, configureLogging, requestLoggingMiddleware } from "logging";
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

  // correlation ID (reused from a well-formed inbound x-request-id or minted)
  // + one access log line per request — see docs/observability.md
  app.use(requestLoggingMiddleware());

  // the POS client is a native app, not a browser — CORS is only relevant
  // for the Swagger UI and any web-based tooling
  app.enableCors({
    origin: env.POS_WEB_URL ?? true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["content-type", "x-pos-device-token", "x-request-id"],
    exposedHeaders: ["x-request-id"],
  });

  const document = SwaggerModule.createDocument(app, createSwaggerConfig());
  SwaggerModule.setup("swagger", app, document, {
    jsonDocumentUrl: "swagger/json",
  });

  await app.listen(env.PORT);
}
bootstrap();
