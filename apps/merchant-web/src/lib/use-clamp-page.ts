import { useEffect } from "react"
import { clampPage } from "./list-search"

// Moves a paginated list view off a `?page=` past its last page, e.g. from a
// stale bookmark, a hand-edited URL, or a delete that emptied the last page.
// It lives in the view, not the route's `beforeLoad`: a delete refetches the
// list without a navigation, so `beforeLoad` never sees the smaller total.
//
// `onClamp` should navigate with `replace: true` and spread the previous search,
// so `q` and filters survive and Back doesn't return to the empty page.
export function useClampPage({
  page,
  query,
  onClamp,
}: {
  page: number
  query: { data?: { total: number }; isPlaceholderData: boolean }
  onClamp: (page: number) => void
}) {
  // while keepPreviousData shows the last page's rows, `total` is the old count
  const total = query.isPlaceholderData ? undefined : query.data?.total

  useEffect(() => {
    if (total === undefined) return
    const clamped = clampPage(page, total)
    if (clamped !== page) onClamp(clamped)
  }, [page, total, onClamp])
}
