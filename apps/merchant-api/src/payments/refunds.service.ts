import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import Stripe from 'stripe';
import { type db as Db, eq, stripeAccountsTable } from 'db/payments';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { STRIPE } from './payments.constants';

export interface RefundPaymentIntentInput {
  // the tenant whose connected account took the payment
  accountId: number;
  paymentIntentId: string;
  amountCents: number;
  // stable per logical refund — a double-submit returns Stripe's existing refund
  idempotencyKey: string;
}

// Stripe refunds against a merchant's connected account. `payments` owns this
// because it owns the Connect mapping (stripe_accounts); `sales` reaches it
// through a port (see sales/orders/ports/payments.port.ts and ARCHITECTURE.md).
@Injectable()
export class StripeRefundsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    @Inject(STRIPE) private readonly stripe: Stripe,
  ) {}

  async refundPaymentIntent(
    input: RefundPaymentIntentInput,
  ): Promise<{ stripeRefundId: string }> {
    const [account] = await this.db
      .select({ stripeAccountId: stripeAccountsTable.stripeAccountId })
      .from(stripeAccountsTable)
      .where(eq(stripeAccountsTable.accountId, input.accountId));
    if (!account) {
      throw new ConflictException(
        `Account ${input.accountId} has no connected Stripe account`,
      );
    }

    try {
      const refund = await this.stripe.refunds.create(
        { payment_intent: input.paymentIntentId, amount: input.amountCents },
        {
          stripeAccount: account.stripeAccountId,
          idempotencyKey: input.idempotencyKey,
        },
      );
      return { stripeRefundId: refund.id };
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeError &&
        err.code === 'charge_already_refunded'
      ) {
        // caller reconciles — the money already left, we just don't have a row
        throw new ConflictException(
          'This payment has already been fully refunded in Stripe',
        );
      }
      // cause: the exception filter logs it, so the Stripe stack survives
      throw new BadGatewayException(
        `Stripe refund failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}
