import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { ShipFromDto } from './ship-from.dto';

export class CreateLocationDto extends ShipFromDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name: string;

  constructor(name: string) {
    super();
    this.name = name;
  }
}
