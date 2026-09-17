// validates process.env (and loads .env via `config`'s dotenv) before
// anything else — nothing else in this app imports env early enough
import { env } from './env';
import { NestFactory } from '@nestjs/core';
import { Logger, configureLogging } from 'logging';
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
  const app = await NestFactory.create(AppModule, {
    logger: new Logger(),
  });
  await app.listen(env.PORT);
}
bootstrap();
