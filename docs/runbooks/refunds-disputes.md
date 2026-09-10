# Runbook: refunds & disputes

How money flows back out of an order, and what OrderSail does when Stripe tells
it a refund or a dispute happened. Companion to `web-checkout.md`.

## Refunds

Two ways a refund gets created:

1. **In OrderSail** — `POST /orders/:id/refunds` (merchant-web, or the API
   directly). `merchant-api` `RefundsService.refundOrder`:
   - calls `stripe.refunds.create({ payment_intent, amount }, { stripeAccount, idempotencyKey })`
     on the merchant's connected account (via the `payments` context)
   - in one transaction: writes the negative `order_payments` row
     (`stripeRefundId` set), the `return` `inventory_movements` + balance bump
     (unless `restock: false` / an amount-only refund), moves `orders.status`
     (`partially_refunded` → `refunded` once the net collected hits 0), and a
     `refund` `order_events` row
   - modes: full (no body fields), `amountCents` (ad-hoc, no restock),
     `lines: [{ orderItemId, quantity }]` (priced from the item snapshot,
     restocked, `order_refund_lines` rows written). Caps: cumulative ≤
     `amountTotalCents`; per line ≤ ordered qty.

2. **In the Stripe Dashboard** — the merchant refunds a payment directly.
   Stripe sends `charge.refunded`; `StripeWebhookController` emits the
   `charge.refunded` domain event; `sales` `ChargeEventsHandler` →
   `RefundsService.reconcileExternalRefund`:
   - finds the order by `order_payments.stripePaymentIntentId`
   - for each Stripe refund on the charge **not already** in `order_payments`
     (matched on `stripeRefundId`), writes the negative row + status move + a
     `refund` event, `actorType: 'system'`, **no restock** (an external refund
     carries no line intent — adjust stock by hand if needed)
   - refunds OrderSail issued are already recorded → skipped; a redelivered
     event is a no-op

If a refund we issued fails to write to the DB (Stripe succeeded, the
transaction didn't), path 2 heals it — the same `charge.refunded` event Stripe
sends reconciles the missing row.

### Verify (local, Stripe test mode)

```
# issue a refund in OrderSail
curl -XPOST localhost:3000/orders/1/refunds -H 'authorization: Bearer <jwt>' \
  -H 'content-type: application/json' -d '{"reason":"test"}'

# or in the Dashboard, then watch the CLI:
npm run stripe:listen -w merchant-api   # → charge.refunded → [200]
```

```sql
select method, "amountCents", "stripeRefundId", reason from order_payments where "orderId" = 1 order by id;
select type, message from order_events where "orderId" = 1 order by id;
select status from orders where id = 1;
```

## Disputes (chargebacks)

`charge.dispute.created` / `.closed` / `.funds_withdrawn` / `.funds_reinstated`
→ `charge.dispute.updated` domain event → `DisputesService.recordDisputeEvent`:

- writes a `note` `order_events` row on the matched order (deduped per
  dispute id + event type, so a redelivery doesn't double-note)
- logs an `[alert]`-shaped line (`grep '\[alert\]'` — same convention as the
  order-job dead-letter, see `alerts.md`)
- **does not** touch the money. The merchant responds with evidence in the
  Stripe Dashboard. Full chargeback accounting (reversing the collected amount,
  the platform fee) is OS-141 / Payments M4.

`charge.dispute.created`'s note carries the evidence `due_by` date. A lost
dispute's note reads `Dispute lost — $X withdrawn`.

## Webhook subscription

Add these to the one Stripe event destination (see `web-checkout.md` §
Production for the recipe): `charge.refunded`, `charge.dispute.created`,
`charge.dispute.closed`, `charge.dispute.funds_withdrawn`,
`charge.dispute.funds_reinstated`.

## Not covered (later)

- Fee reversal proportional to a refund — OS-139 / M4
- Reversing the collected amount + fee on a lost dispute — OS-141 / M4
- POS card/cash refunds — M3 (OS-134); a cancelled POS order's response says
  `refundIssued: false` so the cashier knows to refund at the terminal
