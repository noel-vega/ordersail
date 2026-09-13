import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DRIZZLE } from '../../database/database.constants';
import { storefrontOriginsTable, type db as Db } from 'db';

// always allowed regardless of what's registered, so local dev never breaks
export const LOCAL_DEV_ORIGIN = 'http://localhost:3002';

const REFRESH_INTERVAL_MS = 30_000;

// Backs storefront-api's CORS allowlist. Storefronts can be hosted on any
// merchant-owned domain, so there's no single origin to hardcode — this
// caches every registered `storefront_origins` row in memory (cheap: an
// unbounded per-request DB hit on every CORS preflight isn't worth it at
// this traffic level) and refreshes on an interval so a newly registered
// origin takes effect without a restart.
@Injectable()
export class CorsOriginsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CorsOriginsService.name);
  private origins = new Set<string>();
  private interval?: NodeJS.Timeout;

  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async onModuleInit() {
    await this.refresh();
    this.interval = setInterval(() => {
      this.refresh().catch((err: unknown) =>
        this.logger.error('failed to refresh storefront origins', err),
      );
    }, REFRESH_INTERVAL_MS);
    this.interval.unref();
  }

  onModuleDestroy() {
    clearInterval(this.interval);
  }

  isAllowed(origin: string): boolean {
    return origin === LOCAL_DEV_ORIGIN || this.origins.has(origin);
  }

  // public so a spec (or a manual admin trigger, later) can force a reload
  // without waiting out REFRESH_INTERVAL_MS
  async refresh(): Promise<void> {
    const rows = await this.db
      .select({ origin: storefrontOriginsTable.origin })
      .from(storefrontOriginsTable);
    this.origins = new Set(rows.map((r) => r.origin));
  }
}
