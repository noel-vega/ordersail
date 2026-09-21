import { eq, usersTable } from 'db';
import { lockWaiters } from './lock-waiters.js';
import type { TestDb } from './test-db/db.js';

// Makes "two operations on this User at the same moment" a fact rather than
// a hope. Two calls fired from one Promise.all usually interleave, but
// nothing promises it, and a concurrency spec that passes because the
// scheduler happened to run them back to back proves nothing.
//
// So the User's row is held FOR UPDATE from a transaction of our own before
// the contenders start. Every Identity operation that touches a User takes
// that row before any other (a redemption of an Emailed link, a Session
// sweep, a deactivation), so each contender runs its unlocked reads and
// then parks there. Only once Postgres reports all of them waiting on a
// lock — i.e. every one is past whatever it read before deciding — is the
// row released, and what happens next is decided by the writes alone.
//
// Fails loudly rather than silently passing if they never block: an
// implementation that takes no lock at all is exactly the bug these specs
// exist to catch, and lockWaiters says "the race was not staged".
//
// To fix who is first in line, have `start` launch one contender, await
// lockWaiters(db, 1), then launch the next.
export async function raceForUserRow<T>(
  db: TestDb,
  userId: number,
  contenders: number,
  start: () => Promise<T>,
): Promise<T> {
  let racing: Promise<T> | undefined;
  await db.transaction(async (tx) => {
    await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .for('update');

    racing = start();
    // a contender that fails while we're still polling is reported by the
    // `await racing` below, not as an unhandled rejection in the meantime
    racing.catch(() => undefined);

    await lockWaiters(tx, contenders);
  });
  if (!racing) throw new Error('raceForUserRow: contenders never started');
  return await racing;
}
