import { integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestampAt } from "../utils.js";
import { accountsTable } from "./accounts.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

export const usersTable = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  accountId: integer()
    .notNull()
    .references(() => accountsTable.id, { onDelete: "cascade" }),
  firstname: text("first_name").notNull(),
  lastname: text("last_name").notNull(),
  phone: text("phone"),
  email: varchar({ length: 255 }).notNull().unique(),
  // null until the user joins via the invite link and sets one — staff
  // created from the admin dashboard don't get a password up front
  password: varchar({ length: 255 }),
  // set → the staff member is deactivated: sign-in is refused and every
  // effective-permission lookup returns empty (so every gated route 403s),
  // but their row + history stay and they still show in the staff list
  // (badged) so an owner can reactivate them. Mirrors account_api_keys.revokedAt.
  deactivatedAt: timestamp("deactivated_at"),
  // null until the owner-signup or staff-invite email address is proven —
  // set at accept-invite time (clicking the invite link already proves
  // ownership) or by verify-email for a self-signup account. Sign-in isn't
  // blocked on this (OS-470) — an unverified account is gated post-login
  // instead, by EmailVerifiedGuard reading the JWT's emailVerified claim.
  emailVerifiedAt: timestamp("email_verified_at"),
  // The WebAuthn user handle — the opaque id handed to the authenticator at
  // registration, which then lives in the user's password manager or synced
  // keychain for as long as the passkey does. Deliberately not the primary
  // key: user.id is sequential and tenant-scoped, and there's no reason to
  // persist that in a third party's storage.
  //
  // It belongs on the user, not on user_passkeys, because it must be stable
  // across every credential they register — a per-credential handle makes
  // password managers show one separate entry per passkey.
  //
  // Unique because it *is* an identity as far as an authenticator is
  // concerned: password managers group credentials by (rpId, userHandle),
  // so two users sharing a handle would show up as one account and could
  // overwrite each other's entries. The random default makes a collision
  // implausible, but InsertUserSchema lets a caller pass one explicitly —
  // the constraint is what actually forbids it.
  webauthnHandle: text("webauthn_handle")
    .notNull()
    .unique()
    .default(sql`gen_random_uuid()::text`),
  createdAt: timestampAt("created_at"),
  updatedAt: timestampAt("updated_at"),
});

export const SelectUserSchema = createSelectSchema(usersTable);
export type SelectUser = z.infer<typeof SelectUserSchema>;
export const InsertUserSchema = createInsertSchema(usersTable);
export type InsertUser = z.infer<typeof InsertUserSchema>;
