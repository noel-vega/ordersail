import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { timestampAt } from "../utils.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

export const accountsTable = pgTable("accounts", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  // the shipping contact carriers reach out to about a package — some
  // carriers (e.g. USPS) reject label purchases without it, so required
  // up front at signup rather than discovered missing at purchase time
  phone: text("phone").notNull(),
  email: text("email").notNull(),
  // null (default) -> MFA optional; set -> every staff member on this
  // account must have a confirmed TOTP factor to use gated routes
  // (MfaEnrollmentGuard, OS-473). A staff member who isn't enrolled yet
  // still signs in, just gated post-login into forced enrollment —
  // mirrors emailVerifiedAt's post-login-gate precedent (OS-470).
  requireMfaAt: timestamp("require_mfa_at"),
  createdAt: timestampAt("created_at"),
  updatedAt: timestampAt("updated_at"),
});

export const SelectAccountSchema = createSelectSchema(accountsTable);
export type SelectAccount = z.infer<typeof SelectAccountSchema>;
export const InsertAccountSchema = createInsertSchema(accountsTable);
export type InsertAccount = z.infer<typeof InsertAccountSchema>;
