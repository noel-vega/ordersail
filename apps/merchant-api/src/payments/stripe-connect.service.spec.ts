import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { insertAccount, insertStripeAccount, useTestDb } from 'test-support';
import { eq, stripeAccountsTable } from 'db/payments';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { env } from 'src/shared/env';
import { STRIPE } from './payments.constants';
import { StripeConnectService } from './stripe-connect.service';

const db = useTestDb();

function stripeStub() {
  let links = 0;
  return {
    accounts: {
      create: jest.fn().mockResolvedValue({ id: 'acct_new_1' }),
    },
    accountLinks: {
      // a distinct url per call, the way Stripe behaves — links are
      // single-use, so a stub that returned one constant would let a caching
      // bug pass
      create: jest.fn().mockImplementation(() =>
        Promise.resolve({
          url: `https://connect.stripe.com/setup/e/link_${++links}`,
        }),
      ),
    },
    accountSessions: {
      create: jest.fn().mockResolvedValue({ client_secret: 'cs_test_1' }),
    },
  };
}

async function build(stripe: ReturnType<typeof stripeStub>) {
  const ref = await Test.createTestingModule({
    providers: [
      StripeConnectService,
      { provide: DRIZZLE, useValue: db },
      { provide: STRIPE, useValue: stripe },
    ],
  }).compile();
  return ref.get(StripeConnectService);
}

const rowsFor = (accountId: number) =>
  db
    .select()
    .from(stripeAccountsTable)
    .where(eq(stripeAccountsTable.accountId, accountId));

describe('StripeConnectService.createOnboardingLink (OS-498)', () => {
  it('creates the Express account on first call, then links to it', async () => {
    const account = await insertAccount(db);
    const stripe = stripeStub();
    const service = await build(stripe);

    const result = await service.createOnboardingLink(account.id);

    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
    expect(stripe.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'express' }),
    );
    const rows = await rowsFor(account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].stripeAccountId).toBe('acct_new_1');

    expect(stripe.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        account: 'acct_new_1',
        type: 'account_onboarding',
      }),
    );
    expect(result).toEqual({
      url: 'https://connect.stripe.com/setup/e/link_1',
    });
  });

  it('sends the merchant back to the Payments page, distinguishing refresh from return', async () => {
    const account = await insertAccount(db);
    const stripe = stripeStub();
    const service = await build(stripe);

    await service.createOnboardingLink(account.id);

    const [params] = stripe.accountLinks.create.mock.calls[0] as [
      { refresh_url: string; return_url: string },
    ];
    const refresh = new URL(params.refresh_url);
    const back = new URL(params.return_url);
    for (const url of [refresh, back]) {
      expect(url.origin).toBe(new URL(env.MERCHANT_WEB_URL).origin);
      expect(url.pathname).toBe('/app/payments');
    }
    // merchant-web branches on these exact values
    expect(refresh.searchParams.get('onboarding')).toBe('refresh');
    expect(back.searchParams.get('onboarding')).toBe('return');
  });

  it('resumes an unfinished onboarding on the existing account instead of creating a second one', async () => {
    const account = await insertAccount(db);
    await insertStripeAccount(db, {
      accountId: account.id,
      stripeAccountId: 'acct_existing_1',
    });
    const stripe = stripeStub();
    const service = await build(stripe);

    await service.createOnboardingLink(account.id);

    expect(stripe.accounts.create).not.toHaveBeenCalled();
    expect(stripe.accountLinks.create).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'acct_existing_1' }),
    );
    expect(await rowsFor(account.id)).toHaveLength(1);
  });

  it('mints a fresh link on every call — links are single-use', async () => {
    const account = await insertAccount(db);
    const stripe = stripeStub();
    const service = await build(stripe);

    const first = await service.createOnboardingLink(account.id);
    const second = await service.createOnboardingLink(account.id);

    expect(stripe.accountLinks.create).toHaveBeenCalledTimes(2);
    expect(second.url).not.toBe(first.url);
    // ...but still one Stripe account
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
  });
});

// The ungated twin must not be a way around the factor gate (OS-492): it may
// neither create an account nor serve onboarding.
describe('StripeConnectService.createManagementSession', () => {
  it('409s without touching Stripe when the account was never connected', async () => {
    const account = await insertAccount(db);
    const stripe = stripeStub();
    const service = await build(stripe);

    await expect(
      service.createManagementSession(account.id),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(stripe.accounts.create).not.toHaveBeenCalled();
    expect(stripe.accountSessions.create).not.toHaveBeenCalled();
    expect(await rowsFor(account.id)).toHaveLength(0);
  });

  it('never enables the onboarding component', async () => {
    const account = await insertAccount(db);
    await insertStripeAccount(db, {
      accountId: account.id,
      stripeAccountId: 'acct_existing_2',
    });
    const stripe = stripeStub();
    const service = await build(stripe);

    const result = await service.createManagementSession(account.id);

    expect(result).toEqual({ clientSecret: 'cs_test_1' });
    const [params] = stripe.accountSessions.create.mock.calls[0] as [
      { account: string; components: Record<string, unknown> },
    ];
    expect(params.account).toBe('acct_existing_2');
    expect(params.components).not.toHaveProperty('account_onboarding');
  });
});
