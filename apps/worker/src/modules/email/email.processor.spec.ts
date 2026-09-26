import type { Job } from 'bullmq';
import { Logger } from 'logging';
import type { EmailJobData } from 'queue';
import { EmailProcessor } from './email.processor';
import type { MailerService } from './mailer.service';

// the .tsx templates don't resolve under jest, and rendering isn't what's under
// test here — only the failed-job logging
jest.mock('email-templates', () => ({}));

function inviteJob(attemptsMade: number): Job<EmailJobData> {
  return {
    id: 'e-1',
    name: 'staff-invite',
    attemptsMade,
    opts: { attempts: 5 },
    data: {
      type: 'staff-invite',
      correlationId: 'corr-1',
      accountId: 7,
      to: 'invitee@test.com',
      firstName: 'Ann',
      inviteUrl: 'https://merchant.test/invite/abc',
    },
  } as unknown as Job<EmailJobData>;
}

describe('EmailProcessor.onFailed', () => {
  const processor = new EmailProcessor({} as MailerService);

  afterEach(() => jest.restoreAllMocks());

  it('logs a retryable attempt at warn with the job fields, not the payload', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const err = new Error('smtp timeout');

    processor.onFailed(inviteJob(2), err);

    expect(warn).toHaveBeenCalledWith(
      {
        err,
        event: 'email_job.attempt_failed',
        queue: 'email',
        jobId: 'e-1',
        jobName: 'staff-invite',
        attemptsMade: 2,
        attempts: 5,
      },
      expect.any(String),
    );
  });

  it('logs the final attempt at error', () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    processor.onFailed(inviteJob(5), new Error('smtp down'));

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'email_job.failed', attemptsMade: 5 }),
      expect.any(String),
    );
  });
});
