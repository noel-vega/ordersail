import { ApiProperty } from '@nestjs/swagger';

// the current user's identity + effective permission keys — merchant-web reads
// this once on entering /app instead of decoding the JWT client-side (which
// carries no permissions anyway)
export class AuthMe {
  @ApiProperty()
  userId: number;

  @ApiProperty()
  email: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty()
  accountId: number;

  @ApiProperty({ type: [String] })
  permissions: string[];
}
