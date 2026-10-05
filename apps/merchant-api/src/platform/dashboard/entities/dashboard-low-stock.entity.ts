import { ApiProperty } from '@nestjs/swagger';
import { VariantStockRecord } from '../ports/stock.port';

export class DashboardLowStock {
  // The first page of GET /inventory/variants?lowStock=true — the same
  // records, so the card and its "View all" list agree (OS-693). Most urgent
  // first: lowest stock, then product name.
  @ApiProperty({ type: () => [VariantStockRecord] })
  items!: VariantStockRecord[];

  // the threshold `items` were selected with (OS-668), for their badges
  @ApiProperty({ type: Number })
  lowStockThreshold!: number;
}
