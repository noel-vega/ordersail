import type { Queue } from 'bullmq';
import { insertAccount, insertStorefrontOrigin, useTestDb } from 'test-support';
import type { EmailJobData } from 'queue';
import { EmailService } from './email.service';

const db = useTestDb();

function build() {
  const emailQueue = { add: jest.fn() };
  const service = new EmailService(
    db,
    emailQueue as unknown as Queue<EmailJobData>,
  );
  return { service, emailQueue };
}

describe('EmailService.sendThankYouEmail (OS-439)', () => {
  it('falls back to the env default when the account has no registered storefront origin', async () => {
    const account = await insertAccount(db);
    const { service, emailQueue } = build();

    await service.sendThankYouEmail(account.email, account.id, {
      firstName: 'A',
      accountName: 'Store',
    });

    expect(emailQueue.add).toHaveBeenCalledWith(
      'customer-thank-you',
      expect.objectContaining({ storefrontUrl: 'http://localhost:3002' }),
    );
  });

  it("prefers the account's registered storefront origin", async () => {
    const account = await insertAccount(db);
    await insertStorefrontOrigin(db, {
      accountId: account.id,
      origin: 'https://shop.example.com',
    });
    const { service, emailQueue } = build();

    await service.sendThankYouEmail(account.email, account.id, {
      firstName: 'A',
      accountName: 'Store',
    });

    expect(emailQueue.add).toHaveBeenCalledWith(
      'customer-thank-you',
      expect.objectContaining({ storefrontUrl: 'https://shop.example.com' }),
    );
  });
});
