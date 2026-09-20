import { ApiProperty } from '@nestjs/swagger';

export class AccessTokenDto {
  @ApiProperty()
  access_token: string;

  // Type-level only — undecorated, so it never reaches openapi.json, and
  // never assigned. TypeScript is structural: without this a handler typed
  // Promise<AccessTokenDto> could `return pair` and put the refresh token in
  // a response body without a murmur from the compiler. With it, a TokenPair
  // isn't assignable here, and the only way to an AccessTokenDto from one is
  // respondWithSession() — which is also what writes the cookie.
  declare readonly refresh_token?: never;
}
