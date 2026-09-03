// Mimics drizzle's query builder for `select()` chains: awaitable at any point
// in the chain (`select().from().where()` and `select().from()...offset()` both
// resolve), each await consuming the next entry in `results` in the order the
// code under test issues its queries. The returned object is NOT thenable — only
// the chain is — so Nest's injector doesn't await-unwrap it when it resolves a
// `{ provide, useValue }` provider.
export function makeDb(results: unknown[][]) {
  let call = 0;
  const chain: Record<string, unknown> = {
    then: (resolve: (value: unknown) => void) => resolve(results[call++]),
  };
  for (const method of [
    'from',
    'leftJoin',
    'innerJoin',
    'where',
    'groupBy',
    'orderBy',
    'limit',
    'offset',
  ]) {
    chain[method] = jest.fn(() => chain);
  }
  return { select: jest.fn(() => chain) };
}
