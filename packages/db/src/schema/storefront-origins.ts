import { integer, pgTable, text, unique } from "drizzle-orm/pg-core";
import { timestampAt } from "../utils.js";
import { accountsTable } from "./accounts.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

export const storefrontOriginsTable = pgTable(
  "storefront_origins",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer()
      .notNull()
      .references(() => accountsTable.id, { onDelete: "cascade" }),
    // scheme+host only (e.g. "https://shop.example.com") — checked against
    // the request's Origin header to confirm it belongs to the account
    // whose x-app-key made the request (storefront-api's AppKeyGuard); this
    // is the real tenant boundary, CORS itself is permissive (OS-448). An
    // account can register multiple (prod/staging/localhost).
    origin: text("origin").notNull(),
    createdAt: timestampAt("created_at"),
  },
  (t) => [unique().on(t.accountId, t.origin)],
);

export const SelectStorefrontOriginSchema = createSelectSchema(storefrontOriginsTable);
export type SelectStorefrontOrigin = z.infer<typeof SelectStorefrontOriginSchema>;
export const InsertStorefrontOriginSchema = createInsertSchema(storefrontOriginsTable);
export type InsertStorefrontOrigin = z.infer<typeof InsertStorefrontOriginSchema>;
