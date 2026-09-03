import { getTableName, type Table } from 'drizzle-orm';

type Rows = unknown[];
type SelectResponder = Rows | ((call: number) => Rows);
type ReturningResponder = unknown | ((call: number) => unknown);

export interface WriteDbConfig {
  /**
   * Rows returned by `select().from(table)…`, keyed by `getTableName(table)`.
   * The function form receives a 0-based per-table call index, so a loop that
   * queries the same table once per item can return a different row each time.
   */
  select?: Record<string, SelectResponder>;
  /**
   * The single row `insert(table).values(v).returning()` resolves to, keyed by
   * table name; function form is indexed like `select`. Defaults to `{}`.
   */
  returning?: Record<string, ReturningResponder>;
  /** When set, `transaction()` rejects with this instead of running the callback. */
  transactionThrows?: Error;
}

interface InsertCall {
  table: string;
  values: unknown;
}
interface UpsertCall {
  table: string;
  values: unknown;
  set: unknown;
}
interface UpdateCall {
  table: string;
  set: unknown;
}
interface TableCall {
  table: string;
}

export interface WriteDbCalls {
  inserts: InsertCall[];
  upserts: UpsertCall[];
  updates: UpdateCall[];
  deletes: TableCall[];
  selects: TableCall[];
}

/**
 * A fake drizzle client covering the write surface the select-only `makeDb`
 * can't: `insert().values().returning()`, `insert().values().onConflictDoUpdate()`,
 * `update().set().where()`, `delete().where()`, plain `select()…`, and
 * `transaction(cb => cb(tx))`. Every mutation is recorded by table name in call
 * order; reads return canned rows from `config`. The `db` handle also doubles as
 * the `tx` passed to a transaction callback.
 */
export function makeWriteDb(config: WriteDbConfig = {}) {
  const calls: WriteDbCalls = {
    inserts: [],
    upserts: [],
    updates: [],
    deletes: [],
    selects: [],
  };
  const selectCounts: Record<string, number> = {};
  const returningCounts: Record<string, number> = {};

  const nextIndex = (counts: Record<string, number>, key: string): number => {
    const i = counts[key] ?? 0;
    counts[key] = i + 1;
    return i;
  };

  const selectRows = (table: string): Rows => {
    const r = config.select?.[table];
    const i = nextIndex(selectCounts, table);
    return typeof r === 'function' ? r(i) : (r ?? []);
  };

  const returningRow = (table: string): unknown => {
    const r = config.returning?.[table];
    const i = nextIndex(returningCounts, table);
    return typeof r === 'function'
      ? (r as (call: number) => unknown)(i)
      : (r ?? {});
  };

  const selectChain = () => {
    let table = '';
    const chain: Record<string, unknown> = {
      from: (t: Table) => {
        table = getTableName(t);
        calls.selects.push({ table });
        return chain;
      },
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      groupBy: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      then: (resolve: (value: unknown) => void) => resolve(selectRows(table)),
    };
    return chain;
  };

  const insertChain = (t: Table) => {
    const table = getTableName(t);
    let values: unknown;
    const chain: Record<string, unknown> = {
      values: (v: unknown) => {
        values = v;
        return chain;
      },
      returning: () => ({
        then: (resolve: (value: unknown) => void) => {
          calls.inserts.push({ table, values });
          resolve([returningRow(table)]);
        },
      }),
      onConflictDoUpdate: (cfg: { set?: unknown }) => ({
        then: (resolve: (value: unknown) => void) => {
          calls.upserts.push({ table, values, set: cfg?.set });
          resolve(undefined);
        },
      }),
      then: (resolve: (value: unknown) => void) => {
        calls.inserts.push({ table, values });
        resolve(undefined);
      },
    };
    return chain;
  };

  const updateChain = (t: Table) => {
    const table = getTableName(t);
    return {
      set: (set: unknown) => ({
        where: () => ({
          then: (resolve: (value: unknown) => void) => {
            calls.updates.push({ table, set });
            resolve(undefined);
          },
        }),
      }),
    };
  };

  const deleteChain = (t: Table) => {
    const table = getTableName(t);
    return {
      where: () => ({
        then: (resolve: (value: unknown) => void) => {
          calls.deletes.push({ table });
          resolve(undefined);
        },
      }),
    };
  };

  const db: {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
  } = {
    select: jest.fn(() => selectChain()),
    insert: jest.fn((t: Table) => insertChain(t)),
    update: jest.fn((t: Table) => updateChain(t)),
    delete: jest.fn((t: Table) => deleteChain(t)),
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation(
    async (cb: (tx: unknown) => unknown): Promise<unknown> => {
      if (config.transactionThrows) throw config.transactionThrows;
      return cb(db);
    },
  );

  const valuesFor = (
    list: { table: string; values: unknown }[],
    table: string,
  ) => list.filter((c) => c.table === table).map((c) => c.values);

  return {
    db,
    calls,
    /** payloads passed to `insert(table).values(...)`, in call order */
    inserted: (table: string) => valuesFor(calls.inserts, table),
    /** `{ table, values, set }` for each `insert(table)...onConflictDoUpdate(...)` */
    upserted: (table: string) =>
      calls.upserts.filter((c) => c.table === table),
    /** payloads passed to `update(table).set(...)`, in call order */
    updated: (table: string) =>
      calls.updates.filter((c) => c.table === table).map((c) => c.set),
    /** number of `delete(table).where(...)` calls */
    deleted: (table: string) =>
      calls.deletes.filter((c) => c.table === table).length,
  };
}
