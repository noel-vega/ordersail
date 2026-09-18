CREATE TABLE "user_passkeys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_passkeys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"userId" integer NOT NULL,
	"credential_id" text NOT NULL UNIQUE,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"transports" text[],
	"aaguid" text,
	"nickname" varchar(60) NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webauthn_challenges_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"challenge" text NOT NULL UNIQUE,
	"type" text NOT NULL,
	"userId" integer,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- NOTE: gen_random_uuid() is VOLATILE, so this does not take Postgres 11+'s
-- fast path for adding a defaulted column: it rewrites `users` under an
-- ACCESS EXCLUSIVE lock, evaluating the default per row. That is exactly
-- what we want here (every existing user needs a *distinct* handle, and a
-- non-volatile default would give them all the same one), and `users` is
-- small pre-launch so the lock is momentary.
-- If this table ever grows large, do NOT copy this pattern for another
-- column: add it nullable, backfill in batches, then set the default and
-- NOT NULL separately.
ALTER TABLE "users" ADD COLUMN "webauthn_handle" text DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_webauthn_handle_key" UNIQUE("webauthn_handle");--> statement-breakpoint
CREATE INDEX "user_passkeys_user_id_idx" ON "user_passkeys" ("userId");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_at_idx" ON "webauthn_challenges" ("expires_at");--> statement-breakpoint
ALTER TABLE "user_passkeys" ADD CONSTRAINT "user_passkeys_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;