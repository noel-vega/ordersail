import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { timestampAt } from "../utils.js";
import { usersTable } from "./users.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

// The server-issued nonce for one WebAuthn ceremony, held until the browser
// comes back with a signed response.
//
// This is a table rather than a claim in a short-lived JWT (the way
// mfa_challenge works) because a WebAuthn challenge must be SINGLE-USE, and
// a stateless token can't be single-use without a store to mark it spent —
// so the store is unavoidable either way. Not in-memory either: auth.module
// already notes that the in-memory rate limiter assumes one ECS task, and a
// sign-in-blocking correctness invariant is a much worse thing to hang on
// that assumption than a rate limit.
//
// Consumed with a conditional UPDATE ... RETURNING (the idiom from
// AuthService.consumeRecoveryCode), so two concurrent verifies of the same
// challenge serialize and only one wins. There's no cron anywhere in this
// repo, so expired rows are pruned by whichever call issues the next
// challenge.
export const webauthnChallengesTable = pgTable(
  "webauthn_challenges",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    // base64url, and also the lookup key — the response carries it back
    challenge: text("challenge").notNull().unique(),
    // "registration" | "authentication". Checked on consume so a
    // registration challenge can't be redeemed as an assertion.
    type: text("type").notNull(),
    // NULL for usernameless sign-in, where there is no known user until the
    // credential comes back. Set for registration and for the scoped
    // second-factor ceremony.
    userId: integer().references(() => usersTable.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestampAt("created_at"),
  },
  (table) => [index("webauthn_challenges_expires_at_idx").on(table.expiresAt)],
);

export const SelectWebauthnChallengeSchema = createSelectSchema(webauthnChallengesTable);
export type SelectWebauthnChallenge = z.infer<typeof SelectWebauthnChallengeSchema>;
export const InsertWebauthnChallengeSchema = createInsertSchema(webauthnChallengesTable);
export type InsertWebauthnChallenge = z.infer<typeof InsertWebauthnChallengeSchema>;
