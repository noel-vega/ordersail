import { ApiProperty } from '@nestjs/swagger';

// One registered credential, as the management UI sees it. Deliberately
// carries neither the credential id nor the public key: the client has no
// use for either, and they're the parts worth not handing out.
export class PasskeyDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  nickname: string;

  // 'singleDevice' | 'multiDevice' — multiDevice means it syncs through
  // iCloud Keychain / Google Password Manager and survives losing the
  // device, which is worth telling the user
  @ApiProperty({ nullable: true, type: String })
  deviceType: string | null;

  @ApiProperty()
  backedUp: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ nullable: true, type: Date })
  lastUsedAt: Date | null;
}
