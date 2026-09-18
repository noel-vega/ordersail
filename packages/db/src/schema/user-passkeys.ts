import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { timestampAt } from "../utils.js";
import { usersTable } from "./users.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

// A registered WebAuthn credential. Unlike user_mfa (one TOTP factor per
// user, enforced by a unique userId) a user holds many of these — laptop,
// phone, a hardware key — and manages them individually, so userId is
// indexed but not unique.
export const userPasskeysTable = pgTable(
  "user_passkeys",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    userId: integer()
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // base64url. Unique GLOBALLY, not per user: usernameless sign-in gets
    // only the credential ID back from the authenticator and resolves the
    // user from it, so it has to identify exactly one row across the whole
    // table. The spec also forbids registering one credential twice.
    credentialId: text("credential_id").notNull().unique(),
    // base64url COSE public key — the only half of the keypair we ever see
    publicKey: text("public_key").notNull(),
    // Signature counter. bigint, NOT integer: the spec's counter is a
    // uint32 and int4 tops out at 2^31-1, so a high-count authenticator
    // would overflow a plain integer() column. Every sibling table in this
    // directory uses integer(), which makes that the easy mistake here.
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    // "singleDevice" | "multiDevice" — a multiDevice credential is synced
    // through iCloud Keychain/Google Password Manager and survives losing
    // the device, which is worth surfacing in the management UI
    deviceType: text("device_type"),
    backedUp: boolean("backed_up").notNull().default(false),
    // "internal" | "hybrid" | "usb" | ... — fed back as a hint in
    // allowCredentials so the browser suggests the right authenticator
    transports: text("transports").array(),
    // authenticator model id, kept so the provider can be named later
    // ("iCloud Keychain", "1Password") without re-registering anything
    aaguid: text("aaguid"),
    // user-chosen label. Deliberately not unique — duplicates are harmless
    // (GitHub allows them) and a constraint here would only produce a
    // confusing error in the middle of a registration ceremony.
    nickname: varchar("nickname", { length: 60 }).notNull(),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestampAt("created_at"),
    updatedAt: timestampAt("updated_at"),
  },
  (table) => [index("user_passkeys_user_id_idx").on(table.userId)],
);

export const SelectUserPasskeySchema = createSelectSchema(userPasskeysTable);
export type SelectUserPasskey = z.infer<typeof SelectUserPasskeySchema>;
export const InsertUserPasskeySchema = createInsertSchema(userPasskeysTable);
export type InsertUserPasskey = z.infer<typeof InsertUserPasskeySchema>;
