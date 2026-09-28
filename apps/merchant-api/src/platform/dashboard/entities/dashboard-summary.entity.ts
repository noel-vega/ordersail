import { ApiProperty } from '@nestjs/swagger';
import { OrderListItem, Customer } from '../ports/sales.port';

// point-in-time figures only — money is range-scoped (GET /dashboard/sales)
export class DashboardSummary {
  // variants with zero stock across all locations — the only "stock is a
  // problem" concept that exists anywhere in the app today (see
  // product-inventory-tab.tsx's identical stock <= 0 badge). Not a
  // configurable reorder-point "low stock" alert — no such field exists yet.
  @ApiProperty({ type: Number })
  outOfStockCount!: number;

  @ApiProperty({ type: [OrderListItem] })
  recentOrders!: OrderListItem[];

  @ApiProperty({ type: [Customer] })
  recentCustomers!: Customer[];
}
