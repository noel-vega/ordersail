import { integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { timestampAt } from "../utils.js";
import { usersTable } from "./users.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

// a user has at most one active reset request at a time — same reasoning as
// user_invites: "no pending reset" is just "no row" rather than nullable
// token/expiry columns on usersTable. A fresh request replaces the row via
// onConflictDoUpdate on userId rather than accumulating one per request.
// Deliberately its own table, not a reuse of user_invites — the lifecycle
// differs (an existing active user, not a not-yet-provisioned one) and the
// TTL is much shorter (~1h vs 7d).
export const userPasswordResetsTable = pgTable("user_password_resets", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  userId: integer()
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  token: varchar({ length: 255 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestampAt("created_at"),
});

export const SelectUserPasswordResetSchema = createSelectSchema(userPasswordResetsTable);
export type SelectUserPasswordReset = z.infer<typeof SelectUserPasswordResetSchema>;
export const InsertUserPasswordResetSchema = createInsertSchema(userPasswordResetsTable);
export type InsertUserPasswordReset = z.infer<typeof InsertUserPasswordResetSchema>;
