import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUE_NAMES, type EmailJobData, type OrderJobData } from 'queue';
import { Logger, runWithCorrelationId } from 'logging';
import {
  accountsTable,
  and,
  cartsTable,
  customersTable,
  desc,
  eq,
  failedOrdersTable,
  inventoryMovementsTable,
  inventoryTable,
  isNull,
  orderItemsTable,
  orderPaymentsTable,
  orderShippingTable,
  ordersTable,
  productVariantsTable,
  sql,
  type db as Db,
} from 'db';
import { DRIZZLE } from '../../database/database.constants';
import { AlertsService } from '../alerts/alerts.service';

// order creation, relocated verbatim from storefront-api's CheckoutService
// (which used to run this inline inside the Stripe webhook request) — see
// checkout.service.ts's handleWebhookEvent for the producer side
@Processor(QUEUE_NAMES.ORDERS)
export class OrdersProcessor extends WorkerHost {
  private readonly logger = new Logger(OrdersProcessor.name);
  private lastActiveAt: Date | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue<EmailJobData>,
    private readonly alerts: AlertsService,
  ) {
    super();
  }

  // wrapping the whole method in the job's correlation ID means every log
  // line from here down — including inside db/services this calls — is
  // traceable back to the request that enqueued it, without threading an
  // id through every method signature
  process(job: Job<OrderJobData>): Promise<void> {
    return runWithCorrelationId(job.data.correlationId, async () => {
      const data = job.data;

      switch (data.type) {
        case 'checkout-completed':
          await this.processCheckoutCompleted(data);
          return;

        default: {
          // OrderJobData has only one variant today, so TypeScript can't
          // narrow this branch to `never` (a single-member discriminated
          // union doesn't narrow the same way EmailJobData's two members
          // do) — this becomes a real compile-time exhaustiveness check the
          // moment a second variant is added, same pattern as
          // EmailProcessor. Until then it's a runtime guard against a
          // malformed job (Redis doesn't enforce this type).
          const unexpected = data;
          throw new Error(`Unrecognized order job type: ${unexpected.type}`);
        }
      }
    });
  }

  private async processCheckoutCompleted(
    data: Extract<OrderJobData, { type: 'checkout-completed' }>,
  ): Promise<void> {
    // re-check idempotency here too — the webhook handler already checked
    // before enqueueing, but this guards against BullMQ retries or a
    // duplicate Stripe delivery racing a job that's still in flight
    const [existing] = await this.db
      .select({
        id: ordersTable.id,
        confirmationEmailQueuedAt: ordersTable.confirmationEmailQueuedAt,
      })
      .from(orderPaymentsTable)
      .innerJoin(ordersTable, eq(ordersTable.id, orderPaymentsTable.orderId))
      .where(
        eq(
          orderPaymentsTable.stripeCheckoutSessionId,
          data.stripeCheckoutSessionId,
        ),
      );
    if (existing) {
      // the order itself is done, but if the worker died between the
      // transaction below committing and the email enqueueing (BullMQ
      // redelivers on a stalled job the same way it does on failure), this
      // redelivery is the only remaining chance to send it
      if (!existing.confirmationEmailQueuedAt) {
        await this.enqueueOrderConfirmationEmail(existing.id, data);
      }
      return;
    }

    let orderId!: number;

    await this.db.transaction(async (tx) => {
      const recordSoldMovement = async (
        orderItemId: number,
        variantId: number,
        locationId: number,
        quantity: number,
      ) => {
        const delta = -quantity;
        await tx.insert(inventoryMovementsTable).values({
          orderItemId,
          variantId,
          locationId,
          delta,
          reason: 'sold',
        });
        await tx
          .insert(inventoryTable)
          .values({ variantId, locationId, stock: delta })
          .onConflictDoUpdate({
            target: [inventoryTable.variantId, inventoryTable.locationId],
            set: {
              stock: sql`${inventoryTable.stock} + ${delta}`,
              updatedAt: new Date(),
            },
          });
      };

      // best-effort link to a registered customer — a guest checkout has no
      // customersTable row, so this stays null the same way customerEmail
      // itself does for POS walk-ins (see ordersTable.customerId's comment)
      const [customer] = await tx
        .select({ id: customersTable.id })
        .from(customersTable)
        .where(
          and(
            eq(customersTable.accountId, data.accountId),
            eq(customersTable.email, data.customerEmail),
          ),
        );

      const [order] = await tx
        .insert(ordersTable)
        .values({
          accountId: data.accountId,
          channel: 'web',
          status: 'paid',
          customerEmail: data.customerEmail,
          customerName: data.customerName,
          customerId: customer?.id ?? null,
          subtotalCents: data.subtotalCents,
          amountTotalCents: data.amountTotalCents,
          shippingCents: data.shippingCents,
        })
        .returning();
      orderId = order.id;

      await tx.insert(orderShippingTable).values({
        orderId: order.id,
        line1: data.shippingLine1,
        line2: data.shippingLine2,
        city: data.shippingCity,
        state: data.shippingState,
        postalCode: data.shippingPostalCode,
        country: data.shippingCountry,
        locationId: data.shippingLocationId,
      });

      await tx.insert(orderPaymentsTable).values({
        orderId: order.id,
        method: 'stripe',
        amountCents: data.amountTotalCents,
        stripeCheckoutSessionId: data.stripeCheckoutSessionId,
        stripePaymentIntentId: data.stripePaymentIntentId,
      });

      for (const item of data.items) {
        // snapshotted so a later label purchase doesn't depend on the
        // variant still existing, same reasoning as productName/sku above
        const [variant] = await tx
          .select({ weightOz: productVariantsTable.weightOz })
          .from(productVariantsTable)
          .where(eq(productVariantsTable.id, item.variantId));

        const [orderItem] = await tx
          .insert(orderItemsTable)
          .values({
            orderId: order.id,
            variantId: item.variantId,
            productName: item.productName,
            sku: item.sku,
            optionsLabel: item.optionsLabel,
            priceCents: item.priceCents,
            quantity: item.quantity,
            weightOz: variant?.weightOz ?? null,
          })
          .returning();

        // greedy across locations, highest stock first — if stock runs out
        // entirely the sale is still recorded against the last location and
        // allowed to go negative; the payment already succeeded and can't
        // be silently undone
        const inventoryRows = await tx
          .select({
            locationId: inventoryTable.locationId,
            stock: inventoryTable.stock,
          })
          .from(inventoryTable)
          .where(eq(inventoryTable.variantId, item.variantId))
          .orderBy(desc(inventoryTable.stock));

        let remaining = item.quantity;
        for (const row of inventoryRows) {
          if (remaining <= 0) break;
          const take = Math.min(Math.max(row.stock, 0), remaining);
          if (take <= 0) continue;
          await recordSoldMovement(
            orderItem.id,
            item.variantId,
            row.locationId,
            take,
          );
          remaining -= take;
        }
        if (remaining > 0 && inventoryRows.length > 0) {
          await recordSoldMovement(
            orderItem.id,
            item.variantId,
            inventoryRows[0].locationId,
            remaining,
          );
        }
      }

      await tx
        .delete(cartsTable)
        .where(
          and(
            eq(cartsTable.token, data.cartToken),
            eq(cartsTable.accountId, data.accountId),
          ),
        );
    });

    await this.enqueueOrderConfirmationEmail(orderId, data);
  }

  // deliberately caught, not thrown — the order is already committed at
  // this point, and throwing would just make BullMQ retry the whole job.
  // confirmationEmailQueuedAt staying null on failure is what actually makes
  // that retry (or a stalled-job redelivery) useful: the top-of-function
  // idempotency check re-attempts this specific call instead of returning
  // immediately. A logged failure here is recoverable via redelivery; a lost
  // order is not.
  private async enqueueOrderConfirmationEmail(
    orderId: number,
    data: Extract<OrderJobData, { type: 'checkout-completed' }>,
  ): Promise<void> {
    try {
      const [account] = await this.db
        .select({ name: accountsTable.name })
        .from(accountsTable)
        .where(eq(accountsTable.id, data.accountId));

      await this.emailQueue.add('order-confirmation', {
        type: 'order-confirmation',
        // forwarded, not regenerated — keeps the order and its confirmation
        // email traceable under the same id as the original checkout request
        correlationId: data.correlationId,
        to: data.customerEmail,
        customerName: data.customerName,
        accountName: account?.name ?? '',
        orderId,
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
        storefrontUrl: data.storefrontUrl,
      });

      // if this update fails/crashes right after the add() above succeeds,
      // the next redelivery enqueues a duplicate email rather than none —
      // same "duplicate over lost" trade-off ORDER_JOB_OPTIONS already makes
      await this.db
        .update(ordersTable)
        .set({ confirmationEmailQueuedAt: new Date() })
        .where(eq(ordersTable.id, orderId));
    } catch (err) {
      this.logger.error(
        `Order ${orderId} was created but failed to enqueue its confirmation email: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // used by HealthService to tell "quiet queue" apart from "stuck queue" —
  // see modules/health/health.service.ts
  @OnWorkerEvent('active')
  onActive() {
    this.lastActiveAt = new Date();
  }

  // read by HealthService.checkOrdersQueue; must be the same processor
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
  // explicitly from job.data, same id either way. These handlers are
  // fire-and-forget from BullMQ's side; the try/catch keeps a DB hiccup in
  // the bookkeeping from turning into an unhandled rejection.
  @OnWorkerEvent('failed')
  async onFailed(job: Job<OrderJobData>, err: Error) {
    await runWithCorrelationId(job.data.correlationId, async () => {
      const attempts = job.opts.attempts ?? 1;
      const exhausted = job.attemptsMade >= attempts;

      if (!exhausted) {
        this.logger.warn(
          `Job ${job.id} (${job.name}) failed on attempt ${job.attemptsMade}/${attempts}: ${err.message}`,
        );
        return;
      }

      const data = job.data;
      if (data.type !== 'checkout-completed') {
        this.logger.error(
          `Job ${job.id} (${job.name}) failed permanently after ${job.attemptsMade} attempts — needs manual review: ${err.message}`,
        );
        return;
      }

      // All retries used up — a paid customer with no order, the worst
      // failure this system has. Record it as a first-class row (keyed on the
      // checkout session, so a replay that fails again updates rather than
      // duplicates), emit one [alert]-shaped line carrying the unresolved
      // count, and page out-of-band via SNS (OS-73). The BullMQ job itself
      // also stays in Redis (ORDER_JOB_OPTIONS has no removeOnFail).
      let unresolvedCount: number | undefined;
      try {
        await this.db
          .insert(failedOrdersTable)
          .values({
            stripeCheckoutSessionId: data.stripeCheckoutSessionId,
            stripePaymentIntentId: data.stripePaymentIntentId,
            accountId: data.accountId,
            jobId: job.id ?? null,
            payload: data,
            errorMessage: err.message,
            attempts: job.attemptsMade,
          })
          .onConflictDoUpdate({
            target: failedOrdersTable.stripeCheckoutSessionId,
            set: {
              jobId: job.id ?? null,
              payload: data,
              errorMessage: err.message,
              attempts: job.attemptsMade,
              updatedAt: new Date(),
            },
          });

        const [row] = await this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(failedOrdersTable)
          .where(isNull(failedOrdersTable.resolvedAt));
        unresolvedCount = row?.count;

        this.logger.error(
          `[alert] Job ${job.id} (${job.name}) failed permanently after ${job.attemptsMade} attempts — ` +
            `order NOT created for checkout ${data.stripeCheckoutSessionId}: ${err.message}. ` +
            `${unresolvedCount ?? '?'} unresolved failed order(s).`,
        );
      } catch (recordErr) {
        this.logger.error(
          `Job ${job.id}: order creation failed AND recording the failed_orders row failed: ` +
            `${recordErr instanceof Error ? recordErr.message : recordErr} (original: ${err.message})`,
        );
      }

      // Page regardless of whether the row write above succeeded — a failed
      // write makes the alert *more* urgent, not less. AlertsService is a
      // no-op with no topic configured (local/tests/CI) and never throws.
      // TODO(OS-69): also Sentry.captureException(err, { level: 'fatal' })
      // here once the Sentry SDK is wired into the worker.
      await this.alerts.publishCritical({
        subject: `[ordersail] Order NOT created — checkout ${data.stripeCheckoutSessionId}`,
        message: [
          'An order job exhausted all retries. A customer has paid and has no order.',
          '',
          `Job:              ${job.id} (${job.name})`,
          `Attempts:         ${job.attemptsMade}`,
          `Checkout session: ${data.stripeCheckoutSessionId}`,
          `Payment intent:   ${data.stripePaymentIntentId}`,
          `Account:          ${data.accountId}`,
          `Customer:         ${data.customerEmail}`,
          `Amount:           ${(data.amountTotalCents / 100).toFixed(2)}`,
          `Error:            ${err.message}`,
          `Failed at:        ${new Date().toISOString()}`,
          unresolvedCount === undefined
            ? 'Unresolved failed orders: unknown (failed_orders write also failed)'
            : `Unresolved failed orders: ${unresolvedCount}`,
          '',
          'Replay: docs/runbooks/alerts.md → "When \'order-job dead-letter\' fires".',
        ].join('\n'),
      });
    });
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job<OrderJobData>) {
    await runWithCorrelationId(job.data.correlationId, async () => {
      const sessionId =
        job.data.type === 'checkout-completed'
          ? job.data.stripeCheckoutSessionId
          : '';
      this.logger.log(
        `Job ${job.id} (${job.name}) created order for session ${sessionId}`,
      );

      if (!sessionId) return;
      // A job for this session finally succeeded (a manual replay, or even
      // the idempotent short-circuit once the order exists) — clear any
      // failed_orders row it left behind. A no-op for a normal first-time
      // order: there's no matching row.
      try {
        const [resolved] = await this.db
          .update(failedOrdersTable)
          .set({
            resolvedAt: new Date(),
            resolvedBy: 'worker',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(failedOrdersTable.stripeCheckoutSessionId, sessionId),
              isNull(failedOrdersTable.resolvedAt),
            ),
          )
          .returning({ id: failedOrdersTable.id });
        if (resolved) {
          this.logger.log(
            `Resolved failed_orders row ${resolved.id} — checkout ${sessionId} now has an order`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Job ${job.id}: order created but failed to resolve the failed_orders row for ${sessionId}: ` +
            `${err instanceof Error ? err.message : err}`,
        );
      }
    });
  }
}
