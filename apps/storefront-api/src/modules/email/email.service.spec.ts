import type { Queue } from 'bullmq';
import type { EmailJobData } from 'queue';
import { EmailService } from './email.service';

function build() {
  const emailQueue = { add: jest.fn() };
  const service = new EmailService(emailQueue as unknown as Queue<EmailJobData>);
  return { service, emailQueue };
}

describe('EmailService.sendThankYouEmail', () => {
  it('enqueues a customer-thank-you job with the given params', async () => {
    const { service, emailQueue } = build();

    await service.sendThankYouEmail('buyer@test.com', {
      firstName: 'A',
      accountName: 'Store',
    });

    expect(emailQueue.add).toHaveBeenCalledWith(
      'customer-thank-you',
      expect.objectContaining({
        to: 'buyer@test.com',
        firstName: 'A',
        accountName: 'Store',
      }),
    );
  });
});
