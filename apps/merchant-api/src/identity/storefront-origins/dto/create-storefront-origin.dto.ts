import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateStorefrontOriginDto {
  @ApiProperty({ example: 'https://shop.example.com' })
  @IsString()
  @IsNotEmpty()
  origin: string;
}
