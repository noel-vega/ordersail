import { ApiProperty } from '@nestjs/swagger';

export class Brand {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty()
  name!: string;

  // active products only — draft/archived don't count toward this
  @ApiProperty({ type: Number })
  productCount!: number;
}
