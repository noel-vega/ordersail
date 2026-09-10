// db/stock — the stock context's slice of the schema (locations, inventory,
// inventory movements). See ARCHITECTURE.md.
export * from "../schema/inventory.js";
export {
  eq,
  ne,
  and,
  or,
  gt,
  gte,
  lt,
  lte,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  ilike,
  sql,
  asc,
  desc,
} from "drizzle-orm";
export type { SQL } from "drizzle-orm";
export { db } from "../index.js";
export * from "../postgres-errors.js";
