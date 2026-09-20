import { sql } from 'drizzle-orm';
import type { TestDb } from './test-db/db.js';

// Resolves once Postgres reports at least `count` sessions parked on a lock —
// the building block for staging a race deterministically: hold a row from a
// transaction of the spec's own, start the contenders, and release only once
// every one of them is known to be blocked.
//
// pg_locks, not pg_stat_activity: the stats views are snapshotted on first
// read for the rest of a transaction, so from inside one they would go on
// reporting nobody waiting forever. pg_locks reads the lock manager live.
// Nothing else shares this database (each jest run boots its own container,
// maxWorkers: 1), so any ungranted lock is a contender's.
//
// `executor` is the handle to poll through: the transaction holding the row
// when called from inside it, the plain db otherwise.
export async function lockWaiters(
  executor: Pick<TestDb, 'execute'>,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const { rows } = await executor.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_locks where not granted`,
    );
    const waiting = rows[0]?.waiting ?? 0;
    if (waiting >= count) return;
    if (Date.now() > deadline) {
      throw new Error(
        `lockWaiters: only ${waiting} of ${count} contenders ever blocked on a lock — the race was not staged`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
