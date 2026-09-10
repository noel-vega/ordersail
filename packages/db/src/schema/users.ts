import { integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
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
  createdAt: timestampAt("created_at"),
  updatedAt: timestampAt("updated_at"),
});

export const SelectUserSchema = createSelectSchema(usersTable);
export type SelectUser = z.infer<typeof SelectUserSchema>;
export const InsertUserSchema = createInsertSchema(usersTable);
export type InsertUser = z.infer<typeof InsertUserSchema>;
