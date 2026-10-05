import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { createOwnedRedisClient } from 'queue';
import { sql, type db as Db } from 'db';
import { DRIZZLE } from '../../database/database.constants';

@Injectable()
export class HealthService implements OnModuleDestroy {
  // its own connection, deliberately decoupled from BullMQ's — the
  // simplest way to test raw Redis reachability without reaching into
  // @nestjs/bullmq internals to reuse its connection
  private readonly redis = createOwnedRedisClient({ commandTimeout: 2000 });

  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  // ours, not BullMQ's — see createOwnedRedisClient
  onModuleDestroy() {
    this.redis.disconnect();
  }

  checkDatabase = async () => {
    const indicator = this.healthIndicatorService.check('database');
    try {
      await this.db.execute(sql`select 1`);
      return indicator.up();
    } catch (err) {
      return indicator.down({
        message: err instanceof Error ? err.message : 'unknown error',
      });
    }
  };

  checkRedis = async () => {
    const indicator = this.healthIndicatorService.check('redis');
    try {
      await this.redis.ping();
      return indicator.up();
    } catch (err) {
      return indicator.down({
        message: err instanceof Error ? err.message : 'unknown error',
      });
    }
  };
}
