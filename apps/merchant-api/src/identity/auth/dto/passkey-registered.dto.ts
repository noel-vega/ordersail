import { ApiProperty } from '@nestjs/swagger';
import { PasskeyDto } from './passkey.dto';

export class PasskeyRegisteredDto {
  @ApiProperty({ type: PasskeyDto })
  passkey: PasskeyDto;

  // re-minted so a caller who was being gated isn't stuck behind a stale
  // hasMfaFactor claim for the rest of their token's life
  @ApiProperty()
  access_token: string;

  // present only when this was the user's FIRST factor of any kind — the one
  // and only batch, shown once and never again
  @ApiProperty({ required: false, type: [String] })
  recoveryCodes?: string[];
}
