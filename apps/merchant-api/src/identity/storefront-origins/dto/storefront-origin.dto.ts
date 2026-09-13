import { ApiProperty } from '@nestjs/swagger';

export class StorefrontOriginDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  origin: string;

  @ApiProperty()
  createdAt: Date;
}
