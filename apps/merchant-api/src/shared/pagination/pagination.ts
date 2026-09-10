// Shared paging primitive for the `GET` list endpoints. Controllers read
// `limit` / `offset` as query params (with a `DefaultValuePipe` + `ParseIntPipe`,
// same style as sales/orders/orders.controller.ts); services call
// `resolvePageParams` to clamp them and return a `Page<T>`.

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface PageParams {
  limit: number;
  offset: number;
}

// Clamp caller-supplied paging to a safe window: `limit` into
// [1, MAX_PAGE_SIZE] (a missing / zero / non-finite value falls back to
// DEFAULT_PAGE_SIZE), `offset` floored at 0.
export function resolvePageParams(limit: number, offset: number): PageParams {
  const l = Math.trunc(limit);
  const o = Math.trunc(offset);
  return {
    limit: Math.min(
      Math.max(Number.isFinite(l) && l > 0 ? l : DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    ),
    offset: Math.max(Number.isFinite(o) ? o : 0, 0),
  };
}

// The shape every paginated list endpoint returns. Each resource also declares
// a concrete `Paginated<Resource>` entity (so the OpenAPI schema keeps a
// specific name) whose fields match this.
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
