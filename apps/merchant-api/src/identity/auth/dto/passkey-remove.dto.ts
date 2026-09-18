import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class PasskeyRemoveDto {
  // removing a factor takes the same re-authentication bar as disabling one
  @ApiProperty()
  @IsString()
  @MinLength(1)
  password: string;
}
