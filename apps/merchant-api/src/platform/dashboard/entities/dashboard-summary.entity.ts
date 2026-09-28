import { ApiProperty } from '@nestjs/swagger';
import { OrderListItem, Customer } from '../ports/sales.port';

// point-in-time figures only — money is range-scoped (GET /dashboard/sales)
export class DashboardSummary {
  // Variants judged on their stock summed across every location (OS-195);
  // archived products aren't counted. Out = 0 or below; low = above 0 and
  // at or below lowStockThreshold, so the two never overlap.
  @ApiProperty({ type: Number })
  outOfStockCount!: number;

  @ApiProperty({ type: Number })
  lowStockCount!: number;

  // the account's threshold these counts used (OS-668) — returned because a
  // dashboard:read role may not be able to read GET /account
  @ApiProperty({ type: Number })
  lowStockThreshold!: number;

  @ApiProperty({ type: [OrderListItem] })
  recentOrders!: OrderListItem[];

  @ApiProperty({ type: [Customer] })
  recentCustomers!: Customer[];
}
