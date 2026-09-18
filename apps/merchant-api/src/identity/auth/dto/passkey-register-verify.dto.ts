import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class PasskeyRegisterVerifyDto {
  // The browser's RegistrationResponseJSON, passed through verbatim to
  // @simplewebauthn/server. Typed as a bare object because it's a deeply
  // polymorphic structure @nestjs/swagger can't model — openapi-typescript
  // renders any attempt as Record<string, never> — so the SDK casts it once
  // on the client side instead. Validating its shape here would duplicate
  // what verifyRegistrationResponse already does properly.
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  response: Record<string, unknown>;

  // what the user calls this credential in the list ("MacBook", "Phone")
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  nickname?: string;
}
