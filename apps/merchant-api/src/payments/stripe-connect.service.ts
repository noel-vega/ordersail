import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type Stripe from 'stripe';
import { type db as Db, eq, stripeAccountsTable } from 'db/payments';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { STRIPE } from './payments.constants';
import { StripeConnectStatus } from './entities/stripe-connect-status.entity';
import { AccountSessionResponse } from './entities/account-session.entity';
import { OnboardingLinkResponse } from './entities/onboarding-link.entity';
import { env } from 'src/shared/env';

@Injectable()
export class StripeConnectService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    @Inject(STRIPE) private readonly stripe: Stripe,
  ) {}

  // First connect, or resuming an unfinished one. Creates the Express
  // account if this merchant has none, then hands back a Stripe-hosted
  // onboarding URL — the money action, and the reason the route carries
  // @RequireMfaFactor (OS-492).
  //
  // Account Links are single-use and expire within minutes, so every call
  // mints a fresh one; never cache or pre-mint. Stripe sends the browser to
  // refresh_url when a link is stale or already spent, and to return_url when
  // the merchant leaves the flow — which includes "Save for later", so
  // landing there does NOT mean onboarding finished. Completion still comes
  // from account.updated / getStatus(refresh).
  async createOnboardingLink(
    accountId: number,
  ): Promise<OnboardingLinkResponse> {
    const stripeAccountId = await this.ensureConnectedAccount(accountId);

    const link = await this.stripe.accountLinks.create({
      account: stripeAccountId,
      type: 'account_onboarding',
      refresh_url: `${env.MERCHANT_WEB_URL}/app/payments?onboarding=refresh`,
      return_url: `${env.MERCHANT_WEB_URL}/app/payments?onboarding=return`,
      // collect everything up front rather than pulling the merchant back
      // into onboarding the first time a future requirement comes due
      collection_options: { fields: 'eventually_due' },
    });

    return { url: link.url };
  }

  // The session behind the embedded management and balance components, for a
  // merchant who is ALREADY connected.
  //
  // Deliberately cannot do what createOnboardingLink does: it refuses when
  // no account exists rather than creating one, and never enables
  // account_onboarding. When the two shared one method, the factor gate on
  // the onboarding route was decorative — the ungated route created the
  // Stripe account and served onboarding, which is precisely what the gate
  // was meant to stand in front of.
  async createManagementSession(
    accountId: number,
  ): Promise<AccountSessionResponse> {
    const [existing] = await this.db
      .select()
      .from(stripeAccountsTable)
      .where(eq(stripeAccountsTable.accountId, accountId));

    if (!existing) {
      throw new ConflictException(
        'This account is not connected to Stripe yet',
      );
    }

    const session = await this.stripe.accountSessions.create({
      account: existing.stripeAccountId,
      components: {
        account_management: { enabled: true },
        balances: { enabled: true },
        notification_banner: { enabled: true },
      },
    });

    return { clientSecret: session.client_secret };
  }

  async getStatus(
    accountId: number,
    refresh: boolean,
  ): Promise<StripeConnectStatus> {
    const [stripeAccount] = await this.db
      .select()
      .from(stripeAccountsTable)
      .where(eq(stripeAccountsTable.accountId, accountId));

    if (!stripeAccount) {
      return {
        connected: false,
        chargesEnabled: false,
        detailsSubmitted: false,
      };
    }

    if (!refresh) {
      return {
        connected: true,
        chargesEnabled: stripeAccount.chargesEnabled,
        detailsSubmitted: stripeAccount.detailsSubmitted,
      };
    }

    const account = await this.stripe.accounts.retrieve(
      stripeAccount.stripeAccountId,
    );
    await this.syncAccountStatus(stripeAccount.stripeAccountId, {
      charges_enabled: account.charges_enabled,
      details_submitted: account.details_submitted,
    });

    return {
      connected: true,
      chargesEnabled: account.charges_enabled,
      detailsSubmitted: account.details_submitted,
    };
  }

  // handles the `account.updated` webhook event — the durable path for
  // keeping charges_enabled/details_submitted in sync; the refresh=true
  // path above is a local-dev/UI fallback for when that hasn't landed yet
  async handleAccountUpdated(
    stripeAccountId: string,
    status: {
      charges_enabled: boolean;
      details_submitted: boolean;
    },
  ): Promise<void> {
    await this.syncAccountStatus(stripeAccountId, status);
  }

  private async syncAccountStatus(
    stripeAccountId: string,
    status: { charges_enabled: boolean; details_submitted: boolean },
  ): Promise<void> {
    await this.db
      .update(stripeAccountsTable)
      .set({
        chargesEnabled: status.charges_enabled,
        detailsSubmitted: status.details_submitted,
        updatedAt: new Date(),
      })
      .where(eq(stripeAccountsTable.stripeAccountId, stripeAccountId));
  }

  private async ensureConnectedAccount(accountId: number): Promise<string> {
    const [existing] = await this.db
      .select()
      .from(stripeAccountsTable)
      .where(eq(stripeAccountsTable.accountId, accountId));

    if (existing) return existing.stripeAccountId;

    const stripeAccount = await this.stripe.accounts.create({
      type: 'express',
      country: 'US',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    await this.db.insert(stripeAccountsTable).values({
      accountId,
      stripeAccountId: stripeAccount.id,
    });

    return stripeAccount.id;
  }
}
