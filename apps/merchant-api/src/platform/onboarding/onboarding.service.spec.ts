import { Test } from '@nestjs/testing';
import {
  insertAccount,
  insertLocation,
  insertProduct,
  insertStripeAccount,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { OnboardingService } from './onboarding.service';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [OnboardingService, { provide: DRIZZLE, useValue: db }],
  }).compile();
  return ref.get(OnboardingService);
}

describe('OnboardingService.getStatus (OS-165)', () => {
  it('is all-false for a fresh post-signup account (address-less Default location)', async () => {
    const account = await insertAccount(db);
    await insertLocation(db, { accountId: account.id, withAddress: false });
    const service = await build();

    expect(await service.getStatus(account.id)).toEqual({
      stripeConnected: false,
      hasCompleteLocation: false,
      hasActiveProduct: false,
      complete: false,
    });
  });

  it('stripeConnected follows charges_enabled', async () => {
    const account = await insertAccount(db);
    await insertStripeAccount(db, {
      accountId: account.id,
      chargesEnabled: false,
    });
    const service = await build();

    expect((await service.getStatus(account.id)).stripeConnected).toBe(false);

    const enabled = await insertAccount(db);
    await insertStripeAccount(db, {
      accountId: enabled.id,
      chargesEnabled: true,
    });
    expect((await service.getStatus(enabled.id)).stripeConnected).toBe(true);
  });

  it('hasCompleteLocation needs all four address fields', async () => {
    const account = await insertAccount(db);
    const service = await build();

    await insertLocation(db, {
      accountId: account.id,
      withAddress: true,
      address: { country: undefined },
    });
    expect((await service.getStatus(account.id)).hasCompleteLocation).toBe(
      false,
    );

    await insertLocation(db, { accountId: account.id, withAddress: true });
    expect((await service.getStatus(account.id)).hasCompleteLocation).toBe(
      true,
    );
  });

  it('hasActiveProduct needs status = active', async () => {
    const account = await insertAccount(db);
    const service = await build();

    await insertProduct(db, { accountId: account.id, status: 'draft' });
    expect((await service.getStatus(account.id)).hasActiveProduct).toBe(false);

    await insertProduct(db, { accountId: account.id, status: 'active' });
    expect((await service.getStatus(account.id)).hasActiveProduct).toBe(true);
  });

  it('complete is true only when all three are', async () => {
    const account = await insertAccount(db);
    await insertStripeAccount(db, {
      accountId: account.id,
      chargesEnabled: true,
    });
    await insertLocation(db, { accountId: account.id, withAddress: true });
    await insertProduct(db, { accountId: account.id, status: 'active' });
    const service = await build();

    expect(await service.getStatus(account.id)).toEqual({
      stripeConnected: true,
      hasCompleteLocation: true,
      hasActiveProduct: true,
      complete: true,
    });
  });

  it('is scoped to the account', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    await insertStripeAccount(db, { accountId: b.id, chargesEnabled: true });
    await insertLocation(db, { accountId: b.id, withAddress: true });
    await insertProduct(db, { accountId: b.id, status: 'active' });
    const service = await build();

    expect(await service.getStatus(a.id)).toEqual({
      stripeConnected: false,
      hasCompleteLocation: false,
      hasActiveProduct: false,
      complete: false,
    });
  });
});
