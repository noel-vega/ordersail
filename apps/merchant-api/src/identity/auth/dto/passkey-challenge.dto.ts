import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsString, MinLength } from 'class-validator';

export class PasskeyChallengeOptionsDto {
  // the token signin() handed back instead of an access token — proof the
  // password was already checked
  @ApiProperty()
  @IsString()
  @MinLength(1)
  challengeToken: string;
}

export class PasskeyChallengeVerifyDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  challengeToken: string;

  // the browser's AuthenticationResponseJSON, passed through verbatim to
  // @simplewebauthn/server — see PasskeyRegisterVerifyDto.response for why
  // this isn't modelled
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  response: Record<string, unknown>;
}
