import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUE_NAMES, type EmailJobData } from 'queue';
import { Logger, runWithCorrelationId } from 'logging';
import {
  renderCustomerThankYouEmail,
  renderOrderConfirmationEmail,
  renderPasswordResetEmail,
  renderStaffInviteEmail,
} from 'email-templates';
import { MailerService } from './mailer.service';

// this is the only place email HTML gets built now — moved here verbatim
// from merchant-api's/storefront-api's EmailService. The HTML itself is
// built by the `email-templates` package (React components rendered to a
// string via react-email) — this file just maps a job's data onto template
// props and sends the result
@Processor(QUEUE_NAMES.EMAIL)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);
  private lastActiveAt: Date | null = null;

  constructor(private readonly mailerService: MailerService) {
    super();
  }

  // errors are intentionally left to propagate — BullMQ marks the job
  // failed and retries per queue.EMAIL_JOB_OPTIONS's backoff, instead of the
  // old inline try/catch that logged and gave up after one attempt.
  //
  // wrapped in the job's correlation ID so every log line here — and inside
  // mailerService — is traceable back to whatever enqueued it (a request, or
  // an order job forwarding its own id)
  process(job: Job<EmailJobData>): Promise<void> {
    return runWithCorrelationId(job.data.correlationId, () =>
      this.processJob(job),
    );
  }

  private async processJob(job: Job<EmailJobData>): Promise<void> {
    const data = job.data;

    switch (data.type) {
      case 'staff-invite':
        await this.mailerService.sendMail({
          to: data.to,
          subject: "You've been invited to join Ordersail",
          html: await renderStaffInviteEmail({
            firstName: data.firstName,
            inviteUrl: data.inviteUrl,
          }),
        });
        return;

      case 'password-reset':
        await this.mailerService.sendMail({
          to: data.to,
          subject: 'Reset your Ordersail password',
          html: await renderPasswordResetEmail({
            firstName: data.firstName,
            resetUrl: data.resetUrl,
          }),
        });
        return;

      // the customer's relationship is with the shop they signed up at, not
      // with the platform — sent as that shop, not as "Ordersail"
      case 'customer-thank-you':
        await this.mailerService.sendMail({
          to: data.to,
          from: { name: data.accountName, address: 'no-reply@ordersail.local' },
          subject: `Thanks for signing up, ${data.firstName}!`,
          html: await renderCustomerThankYouEmail({
            firstName: data.firstName,
            accountName: data.accountName,
          }),
        });
        return;

      // same reasoning as customer-thank-you: sent as the shop the
      // customer bought from, not as "Ordersail"
      case 'order-confirmation':
        await this.mailerService.sendMail({
          to: data.to,
          from: { name: data.accountName, address: 'no-reply@ordersail.local' },
          subject: `Your order from ${data.accountName} is confirmed (#${data.orderId})`,
          html: await renderOrderConfirmationEmail({
            customerName: data.customerName,
            accountName: data.accountName,
            orderId: data.orderId,
            items: data.items,
            subtotalCents: data.subtotalCents,
            shippingCents: data.shippingCents,
            amountTotalCents: data.amountTotalCents,
            shippingLine1: data.shippingLine1,
            shippingLine2: data.shippingLine2,
            shippingCity: data.shippingCity,
            shippingState: data.shippingState,
            shippingPostalCode: data.shippingPostalCode,
            shippingCountry: data.shippingCountry,
          }),
        });
        return;

      default: {
        // compile-time exhaustiveness check: adding a new EmailJobData
        // union member without a case here fails the build, not just the
        // job at runtime
        const _exhaustive: never = data;
        throw new Error(
          `Unrecognized email job type: ${(_exhaustive as EmailJobData).type}`,
        );
      }
    }
  }

  // used by HealthService to tell "quiet queue" apart from "stuck queue" —
  // see modules/health/health.service.ts
  @OnWorkerEvent('active')
  onActive() {
    this.lastActiveAt = new Date();
  }

  // read by HealthService.checkEmailQueue; must be the same processor
  // instance already consuming jobs, never a second one constructed just
  // to query this (that would spin up a duplicate real consumer)
  getLiveness() {
    return {
      isRunning: this.worker.isRunning(),
      isPaused: this.worker.isPaused(),
      lastActiveAt: this.lastActiveAt,
    };
  }

  // BullMQ emits worker events outside of process()'s own async chain, so
  // its ambient correlation ID can't be relied on here — re-establish it
  // explicitly from job.data, same id either way
  @OnWorkerEvent('failed')
  onFailed(job: Job<EmailJobData>, err: Error) {
    runWithCorrelationId(job.data.correlationId, () => {
      this.logger.warn(
        `Job ${job.id} (${job.name}) failed on attempt ${job.attemptsMade}: ${err.message}`,
      );
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<EmailJobData>) {
    runWithCorrelationId(job.data.correlationId, () => {
      this.logger.log(`Job ${job.id} (${job.name}) sent to ${job.data.to}`);
    });
  }
}
