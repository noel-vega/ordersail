import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { timestampAt } from "../utils.js";
import { usersTable } from "./users.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

// one row per user, created unconfirmed at enroll time and either confirmed
// (confirmedAt set) or overwritten by a later enroll attempt — not an
// ephemeral token like user_email_verifications, this is the long-lived
// credential itself once confirmed.
export const userMfaTable = pgTable("user_mfa", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  userId: integer()
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  // AES-256-GCM ciphertext ("iv:authTag:ciphertext", hex-encoded) — never
  // the raw TOTP secret. See shared/mfa/mfa-crypto.ts.
  secret: text("secret").notNull(),
  confirmedAt: timestamp("confirmed_at"),
  createdAt: timestampAt("created_at"),
  updatedAt: timestampAt("updated_at"),
});

export const SelectUserMfaSchema = createSelectSchema(userMfaTable);
export type SelectUserMfa = z.infer<typeof SelectUserMfaSchema>;
export const InsertUserMfaSchema = createInsertSchema(userMfaTable);
export type InsertUserMfa = z.infer<typeof InsertUserMfaSchema>;

// many rows per user — one per issued recovery code. usedAt makes a code
// single-use; a regenerate wipes and reinserts the full batch.
export const userMfaRecoveryCodesTable = pgTable("user_mfa_recovery_codes", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  userId: integer()
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestampAt("created_at"),
});

export const SelectUserMfaRecoveryCodeSchema = createSelectSchema(userMfaRecoveryCodesTable);
export type SelectUserMfaRecoveryCode = z.infer<typeof SelectUserMfaRecoveryCodeSchema>;
export const InsertUserMfaRecoveryCodeSchema = createInsertSchema(userMfaRecoveryCodesTable);
export type InsertUserMfaRecoveryCode = z.infer<typeof InsertUserMfaRecoveryCodeSchema>;
