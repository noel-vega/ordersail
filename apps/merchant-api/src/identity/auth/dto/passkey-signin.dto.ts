import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class PasskeySignInVerifyDto {
  // the browser's AuthenticationResponseJSON — see
  // PasskeyRegisterVerifyDto.response for why this isn't modelled
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  response: Record<string, unknown>;
}
