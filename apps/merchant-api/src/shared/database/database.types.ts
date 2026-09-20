import type { db } from 'db';

// The callback param drizzle hands a `db.transaction()` caller — the same
// query-builder surface as `db` itself, scoped to one transaction. What a
// method takes when it must be able to join a transaction its caller opened
// (in another service, or another module) rather than open its own.
export type DbTransaction = Parameters<
  Parameters<(typeof db)['transaction']>[0]
>[0];
