CREATE TABLE "storefront_origins" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "storefront_origins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"accountId" integer NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "storefront_origins_accountId_origin_unique" UNIQUE("accountId","origin")
);
--> statement-breakpoint
ALTER TABLE "storefront_origins" ADD CONSTRAINT "storefront_origins_accountId_accounts_id_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE;