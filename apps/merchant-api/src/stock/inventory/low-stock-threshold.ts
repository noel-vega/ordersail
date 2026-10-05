import { accountsTable } from 'db/identity';
import { type db as Db, eq } from 'db/stock';

// The account's lowStockThreshold (OS-668). Read once per request and applied
// as a value, so the rows or counts and the threshold returned beside them
// always agree — and callers without account:read still get it. Shared by
// both inventory views (per row and per variant) so they judge "low" alike.
export async function readLowStockThreshold(
  db: typeof Db,
  accountId: number,
): Promise<number> {
  const [{ lowStockThreshold }] = await db
    .select({ lowStockThreshold: accountsTable.lowStockThreshold })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));
  return lowStockThreshold;
}
