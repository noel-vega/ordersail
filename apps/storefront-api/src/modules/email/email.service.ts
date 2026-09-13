import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES, withTimeout, type EmailJobData } from 'queue';
import { Logger, getCorrelationId } from 'logging';
import { env } from '../../env';
import { DRIZZLE } from '../../database/database.constants';
import { storefrontOriginsTable, eq, type db as Db } from 'db';

// this no longer talks to SMTP at all — it enqueues a job for apps/worker
// to actually send. Send failures are retried by the worker; a failure to
// even enqueue is caught below so it can't fail the request that triggered
// it, same guarantee the old inline try/catch-and-log used to provide.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobData>,
  ) {}

  async sendThankYouEmail(
    to: string,
    accountId: number,
    params: { firstName: string; accountName: string },
  ) {
    const storefrontUrl = await this.resolveStorefrontUrl(accountId);
    try {
      await withTimeout(
        this.emailQueue.add('customer-thank-you', {
          type: 'customer-thank-you',
          correlationId: getCorrelationId() ?? randomUUID(),
          to,
          ...params,
          storefrontUrl,
        }),
        5000,
        'enqueue thank-you email',
      );
    } catch (err) {
      this.logger.error(
        `Failed to enqueue thank-you email for ${to}`,
        err instanceof Error ? err.stack : err,
      );
    }
  }

  // storefronts can be hosted on any merchant-owned domain now (OS-431), so
  // there's no single canonical STOREFRONT_WEB_URL to link to — prefer the
  // account's own registered origin, falling back to the env default (local
  // dev, or an account that hasn't registered one yet) so the link is never
  // simply missing
  private async resolveStorefrontUrl(accountId: number): Promise<string> {
    const [registered] = await this.db
      .select({ origin: storefrontOriginsTable.origin })
      .from(storefrontOriginsTable)
      .where(eq(storefrontOriginsTable.accountId, accountId))
      .limit(1);
    return registered?.origin ?? env.STOREFRONT_WEB_URL;
  }
}
