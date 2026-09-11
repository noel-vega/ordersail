import { ApiProperty } from '@nestjs/swagger';

export class CategoryListItem {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ type: Number })
  accountId!: number;

  @ApiProperty()
  name!: string;

  // surfaced so the delete confirm dialog can warn "used by N products" —
  // categoryId cascades silently on delete, nothing else guards it
  @ApiProperty({ type: Number })
  productCount!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
