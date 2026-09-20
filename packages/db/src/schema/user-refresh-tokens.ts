import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { timestampAt } from "../utils.js";
import { usersTable } from "./users.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

// Tracks issued staff refresh tokens for rotation-on-use + reuse detection
// (OS-467, mirrors storefront-api's customer_refresh_tokens from OS-457):
// each row is one refresh token's `jti`, single-use — revoked the moment
// it's redeemed for a new pair. `familyId` is shared across every token in
// one rotation chain (assigned once at signin/signup/accept-invite, carried
// through every rotation); presenting an already-revoked token outside the
// grace window below means the whole family gets revoked, since that's a
// theft signal.
//
// `replacedByJti` records which token superseded this one at rotation time.
// It's what makes the grace window (see SessionsService.refreshTokens) work:
// two genuinely concurrent requests presenting the same then-current token
// (e.g. two tabs both loading the app at once, or merchant-web's
// beforeLoad firing a refresh on every route change) would otherwise have
// the loser mistaken for token theft. Within a short window after
// rotation, a repeat presentation of the just-rotated-out token replays
// the same replacement pair instead of revoking the family. Real reuse —
// presenting a token more than one rotation stale, or outside the window —
// still revokes the family. storefront-api's customer_refresh_tokens
// shipped without this and needed a follow-up fix (OS-461) after hitting
// the race in practice; built in here from the start.
export const userRefreshTokensTable = pgTable("user_refresh_tokens", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  userId: integer()
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  jti: text("jti").notNull().unique(),
  familyId: text("family_id").notNull(),
  replacedByJti: text("replaced_by_jti"),
  createdAt: timestampAt("created_at"),
  revokedAt: timestamp("revoked_at"),
});

export const SelectUserRefreshTokenSchema = createSelectSchema(userRefreshTokensTable);
export type SelectUserRefreshToken = z.infer<typeof SelectUserRefreshTokenSchema>;
export const InsertUserRefreshTokenSchema = createInsertSchema(userRefreshTokensTable);
export type InsertUserRefreshToken = z.infer<typeof InsertUserRefreshTokenSchema>;
