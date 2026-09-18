import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class PasskeyRenameDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  nickname: string;
}
