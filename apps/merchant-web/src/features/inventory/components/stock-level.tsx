import { Badge } from "ui/badge"

// an on-hand quantity, flagged "out" at 0 or below and "low" at or below
// the threshold
export function StockLevel(props: { stock: number; threshold: number }) {
  if (props.stock <= 0) {
    return (
      <Badge variant="destructive" title="Out of stock">
        {props.stock}
        <span className="sr-only"> (out of stock)</span>
      </Badge>
    )
  }
  if (props.stock <= props.threshold) {
    return (
      <Badge variant="warning" title="Low stock">
        {props.stock}
        <span className="sr-only"> (low stock)</span>
      </Badge>
    )
  }
  return <>{props.stock}</>
}
