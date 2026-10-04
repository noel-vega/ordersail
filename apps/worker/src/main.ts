// validates process.env (and loads .env via `config`'s dotenv) before
// anything else — nothing else in this app imports env early enough
import { env } from './env';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  Logger,
  LoggingExceptionFilter,
  configureLogging,
  exitOnFatal,
  installProcessHandlers,
  installShutdownHandler,
  trackRouteTemplates,
} from 'logging';
import { AppModule } from './app.module';

// still no user-facing HTTP API — this only keeps @Processor classes alive
// to consume jobs — but it does now listen, solely for GET /health (see
// modules/health), so an orchestrator/liveness probe can tell this process
// apart from one that's silently wedged (e.g. after a Redis outage)
async function bootstrap() {
  configureLogging({
    service: 'worker',
    nodeEnv: env.NODE_ENV,
    level: env.LOG_LEVEL,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: new Logger() },
  );
  app.useGlobalFilters(new LoggingExceptionFilter(app.getHttpAdapter()));
  // so a failing /health logs its route, not null
  trackRouteTemplates(app.getHttpAdapter().getInstance());
  // closing the app closes the BullMQ workers, which let an in-flight job
  // finish instead of leaving it to be picked up as stalled
  installShutdownHandler(app);
  // Fastify binds loopback only when no host is given. Nothing outside the
  // container calls the worker today (no ALB; the Docker HEALTHCHECK hits
  // localhost), but listen like the APIs so a task-level probe can reach it.
  await app.listen(env.PORT, '0.0.0.0');
}

// before bootstrap() so a crash anywhere — boot included — ends in one fatal
// JSON line instead of a raw stderr trace (docs/observability.md → Errors)
installProcessHandlers();
bootstrap().catch((err) => exitOnFatal(err, 'app.boot_failed'));
