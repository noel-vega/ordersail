// Must stay the first import: tracing patches http, fastify and pg as they
// are loaded, so it has to run before anything below requires them.
import "./instrument";
import { env } from "./env"; // validates process.env before anything else loads
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { SwaggerModule } from "@nestjs/swagger";
import {
  Logger,
  LoggingExceptionFilter,
  configureLogging,
  exitOnFatal,
  installProcessHandlers,
  installShutdownHandler,
  requestLoggingMiddleware,
  setRequestRoute,
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
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: new Logger() },
  );
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new LoggingExceptionFilter(app.getHttpAdapter()));
  // spans still in the batch are sent before the process exits on a deploy
  installShutdownHandler(app, { afterClose: shutdownTracing });

  // correlation ID (reused from a well-formed inbound x-request-id or minted)
  // + one access log line per request — see docs/observability.md. Fastify
  // doesn't put the matched route on the raw request, so report the template
  // from its onRequest hook for the access line.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onRequest", (request, _reply, done) => {
      setRequestRoute(request.raw, request.routeOptions.url);
      done();
    });
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

  // Fastify defaults to binding 'localhost' (loopback only) when no host is given — fine for
  // local dev (same machine), but unreachable from the ALB in ECS, which connects to the
  // task's real VPC IP, not loopback.
  await app.listen(env.PORT, "0.0.0.0");
}

// before bootstrap() so a crash anywhere — boot included — ends in one fatal
// JSON line instead of a raw stderr trace (docs/observability.md → Errors)
installProcessHandlers();
bootstrap().catch((err) => exitOnFatal(err, "app.boot_failed"));
