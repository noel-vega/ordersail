CREATE TABLE "customer_refresh_tokens" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customer_refresh_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"customerId" integer NOT NULL,
	"jti" text NOT NULL UNIQUE,
	"family_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "customer_refresh_tokens" ADD CONSTRAINT "customer_refresh_tokens_customerId_customers_id_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE;