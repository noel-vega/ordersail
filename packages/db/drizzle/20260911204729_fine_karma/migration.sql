ALTER TABLE "orders" ADD COLUMN "customerId" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_customers_id_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL;--> statement-breakpoint
-- OS-189: backfill existing orders by matching the checkout-time snapshotted
-- email against a registered customer in the same account. Best-effort —
-- guest checkouts (no customersTable row) stay null, same as today.
UPDATE "orders" SET "customerId" = c.id
FROM "customers" c
WHERE "orders"."customerEmail" = c.email
  AND "orders"."accountId" = c."accountId"
  AND "orders"."customerId" IS NULL;