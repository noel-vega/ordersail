import { z } from "zod"

// Shared URL-search-param contract for the paginated list pages. Each list
// route sets `validateSearch: listSearchSchema` (products extends it with a
// status filter); the feature query hook takes the parsed search and turns
// `page` into a `limit` / `offset` for the SDK.
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
