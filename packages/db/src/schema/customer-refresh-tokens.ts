import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { timestampAt } from "../utils.js";
import { customersTable } from "./customers.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

// Tracks issued customer refresh tokens for rotation-on-use + reuse
// detection (OS-457): each row is one refresh token's `jti`, single-use —
// revoked the moment it's redeemed for a new pair. `familyId` is shared
// across every token in one rotation chain (assigned once at signup/signin,
// carried through every rotation); presenting an already-revoked token
// means the whole family gets revoked, since that's a theft signal.
export const customerRefreshTokensTable = pgTable("customer_refresh_tokens", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  customerId: integer()
    .notNull()
    .references(() => customersTable.id, { onDelete: "cascade" }),
  jti: text("jti").notNull().unique(),
  familyId: text("family_id").notNull(),
  createdAt: timestampAt("created_at"),
  revokedAt: timestamp("revoked_at"),
});

export const SelectCustomerRefreshTokenSchema = createSelectSchema(customerRefreshTokensTable);
export type SelectCustomerRefreshToken = z.infer<typeof SelectCustomerRefreshTokenSchema>;
export const InsertCustomerRefreshTokenSchema = createInsertSchema(customerRefreshTokensTable);
export type InsertCustomerRefreshToken = z.infer<typeof InsertCustomerRefreshTokenSchema>;
