import { Redis } from "ioredis";
import type { JobsOptions } from "bullmq";

export const QUEUE_NAMES = {
  EMAIL: "email",
  ORDERS: "orders",
} as const;

// URLs are built by the producer (it already knows which frontend's env var
// applies) and carried fully-formed in the payload — the worker never needs
// to know about MERCHANT_WEB_URL itself. Storefront links were removed from
// customer emails (OS-443/444/447) — there's no single correct storefront
// URL in a multi-tenant, bring-your-own-domain system; revisit once there's
// a real per-account deep-linking mechanism.
//
// correlationId rides along on every job so a worker log line can be traced
// back to the request (or the upstream job) that produced it — see
// the `logging` package's runWithCorrelationId/getCorrelationId
export type EmailJobData =
  | { type: "staff-invite"; correlationId: string; to: string; firstName: string; inviteUrl: string }
  | { type: "password-reset"; correlationId: string; to: string; firstName: string; resetUrl: string }
  | { type: "verify-email"; correlationId: string; to: string; firstName: string; verifyUrl: string }
  | {
      type: "customer-thank-you";
      correlationId: string;
      to: string;
      firstName: string;
      accountName: string;
    }
  | {
      type: "order-confirmation";
      correlationId: string;
      to: string;
      customerName: string;
      accountName: string;
      orderId: number;
      items: {
        productName: string;
        sku: string | null;
        optionsLabel: string | null;
        priceCents: number;
        quantity: number;
      }[];
      subtotalCents: number;
      shippingCents: number;
      amountTotalCents: number;
      shippingLine1: string;
      shippingLine2: string | null;
      shippingCity: string;
      shippingState: string | null;
      shippingPostalCode: string;
      shippingCountry: string;
    };

// a flattened snapshot of everything the order-creation transaction needs
// from the Stripe session + cart, resolved by the producer (storefront-api's
// CheckoutService, which already has the cart loaded) so the worker never
// has to touch cart-domain tables/queries itself
export type OrderJobData = {
  type: "checkout-completed";
  correlationId: string;
  accountId: number;
  cartToken: string;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string | null;
  customerEmail: string;
  customerName: string;
  shippingLine1: string;
  shippingLine2: string | null;
  shippingCity: string;
  shippingState: string | null;
  shippingPostalCode: string;
  shippingCountry: string;
  subtotalCents: number;
  amountTotalCents: number;
  shippingCents: number;
  shippingLocationId: number | null;
  items: {
    variantId: number;
    productName: string;
    sku: string | null;
    optionsLabel: string | null;
    priceCents: number;
    quantity: number;
  }[];
};

// centralized retry policy so it isn't copy-pasted per producer — 5
// attempts, exponential backoff starting at 5s (5s, 10s, 20s, 40s).
// removeOnComplete/removeOnFail cap retention (BullMQ's default is
// unlimited) — completed jobs are low-value once sent, failed jobs (all
// retries exhausted) are worth keeping longer for debugging.
export const EMAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
};

// deliberately its own policy, not reused from EMAIL_JOB_OPTIONS: more
// attempts with a longer initial backoff (order processing does more DB
// work per attempt than an email send), and — critically — no removeOnFail
// cap at all. A permanently-failed order job means a customer paid and no
// order was created; unlike a failed email, that must never be silently
// trimmed away, so it keeps BullMQ's unlimited-retention default until a
// human clears it.
export const ORDER_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: "exponential", delay: 10000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
};

// hands BullMQ an already-constructed ioredis client rather than plain
// connection options — under this monorepo's ESM setup, BullMQ's internal
// *dynamic* `require('ioredis')` can't reliably resolve the package across
// workspace symlinks, so we do the (static, ESM-safe) import here instead
// and pass the instance directly. One call per app, at its single
// BullModule.forRoot(...) site.
//
// `maxRetriesPerRequest: null` is required by BullMQ on any client instance
// it's handed directly (it validates for this at startup) — but on its own
// that means a command issued while Redis is unreachable retries forever
// and never rejects, so a caller's try/catch (EmailService) or an unguarded
// await (CheckoutService, deliberately left to throw) would just hang
// instead of failing. `commandTimeout` bounds that: it's opt-in and only
// producer apps (merchant-api, storefront-api) pass it — apps/worker
// calls this with no options, since its Worker duplicates this connection
// for BullMQ's own blocking job-wait reads, which are supposed to sit idle
// for a long time and must not be cut off by a command timeout.
export function createRedisConnection(options?: { commandTimeout?: number }): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
    ...(options?.commandTimeout ? { commandTimeout: options.commandTimeout } : {}),
  });
}

// `commandTimeout` above only bounds a command's round trip once ioredis has
// dispatched it — but BullMQ's Queue.add() first awaits the connection
// reaching "ready", and if Redis is completely unreachable (not just slow),
// that wait never resolves, so commandTimeout never even comes into play.
// Callers that already treat a failed enqueue as non-fatal (both
// EmailService.sendXEmail methods) need this to make good on that guarantee
// — otherwise they hang forever instead of falling into their own catch.
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
