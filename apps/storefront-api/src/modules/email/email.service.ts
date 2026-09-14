import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES, withTimeout, type EmailJobData } from 'queue';
import { Logger, getCorrelationId } from 'logging';

// this no longer talks to SMTP at all — it enqueues a job for apps/worker
// to actually send. Send failures are retried by the worker; a failure to
// even enqueue is caught below so it can't fail the request that triggered
// it, same guarantee the old inline try/catch-and-log used to provide.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobData>,
  ) {}

  async sendThankYouEmail(
    to: string,
    params: { firstName: string; accountName: string },
  ) {
    try {
      await withTimeout(
        this.emailQueue.add('customer-thank-you', {
          type: 'customer-thank-you',
          correlationId: getCorrelationId() ?? randomUUID(),
          to,
          ...params,
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
}
