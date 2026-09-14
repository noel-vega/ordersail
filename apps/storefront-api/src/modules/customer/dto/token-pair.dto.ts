import { ApiProperty } from '@nestjs/swagger';

export class TokenPairDto {
  @ApiProperty()
  access_token: string;

  @ApiProperty()
  refresh_token: string;
}
