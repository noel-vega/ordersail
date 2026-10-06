import { z } from "zod"

// Shared URL-search-param contract for the paginated list pages. Each list
// route sets `validateSearch` from listSearchSchema (products extends it with a
// status filter, orders picks only `page` until its API has a `q`); the
// feature query hook takes the parsed search and turns `page` into a
// `limit` / `offset` for the SDK.
export const PAGE_SIZE = 20

// `.default()` keeps the fields optional when navigating (so a bare
// `<Link to="/app/customers">` still type-checks); `.catch()` guards against a
// junk value in the URL (`?page=abc`).
export const listSearchSchema = z.object({
  page: z.number().int().min(1).default(1).catch(1),
  q: z.string().default("").catch(""),
})

export type ListSearch = z.infer<typeof listSearchSchema>

export function pageOffset(page: number): number {
  return (Math.max(page, 1) - 1) * PAGE_SIZE
}

// the highest page that has rows (an empty list still has page 1)
export function lastPage(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE))
}

// the page a list should be on: `page` itself, or the last page when `page` is
// past the end (a stale bookmark, a hand-edited URL, a delete that emptied the
// last page)
export function clampPage(page: number, total: number): number {
  return Math.min(page, lastPage(total))
}
