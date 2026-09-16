import { integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { timestampAt } from "../utils.js";
import { usersTable } from "./users.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

// same one-active-row-at-a-time shape as user_password_resets — a row only
// exists while verification is outstanding. Longer TTL than a password
// reset (~24h vs ~1h): there's no urgency signal here the way there is for
// "someone is trying to take over your account right now".
export const userEmailVerificationsTable = pgTable("user_email_verifications", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  userId: integer()
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  token: varchar({ length: 255 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestampAt("created_at"),
});

export const SelectUserEmailVerificationSchema = createSelectSchema(userEmailVerificationsTable);
export type SelectUserEmailVerification = z.infer<typeof SelectUserEmailVerificationSchema>;
export const InsertUserEmailVerificationSchema = createInsertSchema(userEmailVerificationsTable);
export type InsertUserEmailVerification = z.infer<typeof InsertUserEmailVerificationSchema>;
