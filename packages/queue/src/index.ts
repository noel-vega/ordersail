import { Redis } from "ioredis";
import { RedisConnection, createIORedisClient, type JobsOptions, type RedisOptions } from "bullmq";
import type { JobLogContext } from "logging";

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
// Every job carries the producer's log context (JobLogContext) so a worker log
// line can be traced back to the request (or the upstream job) that produced
// it, and filtered by tenant — producers spread the `logging` package's
// jobLogContext(), the worker restores it with runWithLogContext(logContextOf(…)).
export type EmailJobData = JobLogContext &
  (
  | { type: "staff-invite"; to: string; firstName: string; inviteUrl: string }
  | { type: "password-reset"; to: string; firstName: string; resetUrl: string }
  | { type: "verify-email"; to: string; firstName: string; verifyUrl: string }
  | {
      type: "customer-thank-you";
      to: string;
      firstName: string;
      accountName: string;
    }
  | {
      type: "order-confirmation";
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
    }
  );

// a flattened snapshot of everything the order-creation transaction needs
// from the Stripe session + cart, resolved by the producer (merchant-api's
// CheckoutOrderService in sales/checkout-orders, which loads the cart when the
// checkout webhook fires) so the worker never has to touch cart-domain
// tables/queries itself
export type OrderJobData = JobLogContext & {
  type: "checkout-completed";
  // required here: an order job always belongs to a tenant
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

// BullMQ builds and closes its own Redis clients from connection *options*.
// Its default path is a dynamic `require('ioredis')`, which can't reliably
// resolve the package across this monorepo's workspace symlinks under ESM —
// so it gets the statically imported constructor through this factory.
//
// Options rather than a pre-built client so the client's owner closes it:
// BullMQ never closes a client it was handed, so a shared instance outlived
// app.close() and kept every script and spec alive (OS-722). The cost is a
// client per Queue/Worker instead of one shared one.
const bullmqClientFactory = (options: RedisOptions) => createIORedisClient(new Redis(options));

// `maxRetriesPerRequest: null` keeps a command from being rejected after a
// fixed number of reconnect attempts — BullMQ requires it on a Worker's
// blocking connection — but on its own that means a command issued while
// Redis is unreachable retries forever and never rejects, so a caller's
// try/catch (EmailService) or an unguarded await (CheckoutService,
// deliberately left to throw) would just hang instead of failing.
// `commandTimeout` bounds that: it's opt-in and only producer apps
// (merchant-api, storefront-api) pass it — apps/worker passes none, since
// BullMQ's blocking job-wait reads are supposed to sit idle for a long time
// and must not be cut off by a command timeout.
//
// Installs the client factory too: options are only usable with it, so they
// come from one place. (Not at import time, where a bundler could drop it.)
export function redisConnectionOptions(options?: { commandTimeout?: number }): RedisOptions {
  RedisConnection.clientFactory = bullmqClientFactory;
  return {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
    ...(options?.commandTimeout ? { commandTimeout: options.commandTimeout } : {}),
  };
}

// A client outside BullMQ (each API's health check) that the caller owns and
// must close on shutdown, with disconnect() rather than quit(): quit() queues a
// command that never completes while Redis is unreachable, so it would stall
// app.close().
export function createOwnedRedisClient(options?: { commandTimeout?: number }): Redis {
  return new Redis(redisConnectionOptions(options));
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
