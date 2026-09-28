import { ApiProperty } from '@nestjs/swagger';
import { InventoryRecord, InventoryMovementRecord } from './inventory.entity';

export class PaginatedInventory {
  @ApiProperty({ type: () => [InventoryRecord] })
  items!: InventoryRecord[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;

  @ApiProperty({
    type: Number,
    description:
      "the account's low-stock threshold — the one lowStock filtered by",
  })
  lowStockThreshold!: number;
}

export class PaginatedInventoryMovements {
  @ApiProperty({ type: () => [InventoryMovementRecord] })
  items!: InventoryMovementRecord[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Number })
  offset!: number;
}
