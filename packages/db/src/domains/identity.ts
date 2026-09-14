// db/identity — the identity context's slice of the schema (accounts, users,
// invites, API keys, RBAC). merchant-api's identity context imports ONLY this;
// see apps/merchant-api/ARCHITECTURE.md. Root `db` is still the full export
// for the dashboard read-model, drizzle-kit, and the other apps.
export * from '../schema/accounts.js';
export * from '../schema/account-api-keys.js';
export * from '../schema/users.js';
export * from '../schema/user-invites.js';
export * from '../schema/rbac.js';
export * from '../permissions-catalog.js';
export {
  eq,
  ne,
  and,
  or,
  gt,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  ilike,
  sql,
  asc,
  desc,
} from 'drizzle-orm';
export type { SQL } from 'drizzle-orm';
export { db } from '../index.js';
export * from '../postgres-errors.js';
