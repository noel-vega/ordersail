-- US-only for now (OS-689): backfill before NOT NULL, or rows saved without a
-- country (every pre-OS-689 name-only location) fail the ALTER
UPDATE "locations" SET "address_country" = 'US' WHERE "address_country" IS DISTINCT FROM 'US';--> statement-breakpoint
ALTER TABLE "locations" ALTER COLUMN "address_country" SET DEFAULT 'US';--> statement-breakpoint
ALTER TABLE "locations" ALTER COLUMN "address_country" SET NOT NULL;