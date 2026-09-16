import { ApiProperty } from '@nestjs/swagger';

export class MfaEnrollResponseDto {
  // otpauth:// URI — the client renders this as a QR code (or shows it as
  // text) for the caller to add to an authenticator app
  @ApiProperty()
  otpauthUrl: string;
}
