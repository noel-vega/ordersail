import { useEffect } from "react"
import { useNavigate } from "@tanstack/react-router"
import { clampPage } from "./list-search"

// Moves a paginated list view off a `?page=` past its last page, e.g. from a
// stale bookmark, a hand-edited URL, or a delete that emptied the last page.
// It lives in the view, not the route's `beforeLoad`: a delete refetches the
// list without a navigation, so `beforeLoad` never sees the smaller total.
//
// It navigates itself so every list makes the same move: the previous search
// is spread (so `q` and filters survive and a filtered list lands on its own
// last page), and `replace` keeps the empty page out of Back.
export function useClampPage({
  page,
  query,
}: {
  page: number
  query: { data?: { total: number }; isPlaceholderData: boolean }
}) {
  const navigate = useNavigate()
  // while keepPreviousData shows the last page's rows, `total` is the old count
  const total = query.isPlaceholderData ? undefined : query.data?.total

  useEffect(() => {
    if (total === undefined) return
    const clamped = clampPage(page, total)
    if (clamped === page) return
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, page: clamped }),
      replace: true,
    })
  }, [page, total, navigate])
}
