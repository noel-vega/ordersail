
// stock is derived (SUM) from per-location inventory rows rather than
// stored directly on the variant — see inventoryTable below

import { integer, pgEnum, pgTable, unique, varchar } from "drizzle-orm/pg-core";
import { productVariantsTable } from "./products.js";
import { usersTable } from "./users.js";
import { accountsTable } from "./accounts.js";
import { orderItemsTable } from "./orders.js";
import { timestampAt } from "../utils.js";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/zod";
import z from "zod";

// a place stock can physically live — starts with a single seeded "Default"
// row, grows into real warehouses/stores without reshaping anything below it
export const locationsTable = pgTable(
  "locations",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer()
      .notNull()
      .references(() => accountsTable.id, { onDelete: "cascade" }),
    name: varchar({ length: 255 }).notNull(),
    // nullable — a location can exist (e.g. the seeded "Default") without a
    // shipping address; only needed once used as a ship-from origin
    addressLine1: varchar("address_line1", { length: 255 }),
    addressLine2: varchar("address_line2", { length: 255 }),
    addressCity: varchar("address_city", { length: 255 }),
    addressState: varchar("address_state", { length: 255 }),
    addressPostalCode: varchar("address_postal_code", { length: 20 }),
    addressCountry: varchar("address_country", { length: 2 }),
    // E.164, validated at the API edge. The contact a carrier reaches at this
    // origin — USPS rejects a label without one — so, like the address, only
    // needed once the location ships (OS-688)
    phone: varchar("phone", { length: 20 }),
    createdAt: timestampAt("created_at"),
    updatedAt: timestampAt("updated_at"),
  },
  (t) => [unique().on(t.accountId, t.name)],
);

export const SelectLocationSchema = createSelectSchema(locationsTable)
export type SelectLocation = z.infer<typeof SelectLocationSchema>
export const InsertLocationSchema = createInsertSchema(locationsTable)
export type InsertLocation = z.infer<typeof InsertLocationSchema>

// on-hand quantity for one variant at one location — the only place stock
// is actually stored; a variant's total stock is SUM(stock) across these
export const inventoryTable = pgTable(
  "inventory",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    variantId: integer()
      .notNull()
      .references(() => productVariantsTable.id, { onDelete: "cascade" }),
    locationId: integer()
      .notNull()
      .references(() => locationsTable.id, { onDelete: "cascade" }),
    stock: integer().notNull().default(0),
    updatedAt: timestampAt("updated_at"),
  },
  (t) => [unique().on(t.variantId, t.locationId)],
);

export const SelectInventorySchema = createSelectSchema(inventoryTable)
export type SelectInventory = z.infer<typeof SelectInventorySchema>
export const InsertInventorySchema = createInsertSchema(inventoryTable)
export type InsertInventory = z.infer<typeof InsertInventorySchema>

export const inventoryMovementReasonEnum = pgEnum("inventory_movement_reason", [
  "received",
  "sold",
  "return",
  "damaged",
  "adjustment",
]);

// the ledger — every change to a variant's stock at a location is recorded
// here first; inventoryTable.stock is a materialized balance kept in sync
// with this, not an independent source of truth
export const inventoryMovementsTable = pgTable("inventory_movements", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  variantId: integer()
    .notNull()
    .references(() => productVariantsTable.id, { onDelete: "cascade" }),
  locationId: integer()
    .notNull()
    .references(() => locationsTable.id, { onDelete: "cascade" }),
  // positive = stock in, negative = stock out
  delta: integer().notNull(),
  reason: inventoryMovementReasonEnum().notNull(),
  // set only for reason: "sold" movements written by the checkout worker —
  // lets fulfillment ask "which order item did this stock come from, and
  // from which location(s)" (SUM(-delta) GROUP BY locationId) instead of
  // needing a separate allocation table kept in sync with this ledger
  orderItemId: integer().references(() => orderItemsTable.id, { onDelete: "set null" }),
  note: varchar({ length: 500 }),
  createdByUserId: integer().references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestampAt("created_at"),
});

export const SelectInventoryMovementSchema = createSelectSchema(inventoryMovementsTable)
export type SelectInventoryMovement = z.infer<typeof SelectInventoryMovementSchema>
export const InsertInventoryMovementSchema = createInsertSchema(inventoryMovementsTable)
export type InsertInventoryMovement = z.infer<typeof InsertInventoryMovementSchema>
