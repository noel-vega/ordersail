// Must stay the first import: tracing patches http, express and pg as they
// are loaded, so it has to run before anything below requires them.
import "./instrument";
import { env } from "./env"; // validates process.env before anything else loads
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import {
  Logger,
  LoggingExceptionFilter,
  configureLogging,
  exitOnFatal,
  installProcessHandlers,
  installShutdownHandler,
  requestLoggingMiddleware,
} from "logging";
import { shutdownTracing } from "tracing";
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
  app.useGlobalFilters(new LoggingExceptionFilter(app.getHttpAdapter()));
  // spans still in the batch are sent before the process exits on a deploy
  installShutdownHandler(app, { afterClose: shutdownTracing });

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

// before bootstrap() so a crash anywhere — boot included — ends in one fatal
// JSON line instead of a raw stderr trace (docs/observability.md → Errors)
installProcessHandlers();
bootstrap().catch((err) => exitOnFatal(err, "app.boot_failed"));
