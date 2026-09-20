import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { IsStrongPassword } from 'password-policy';

export class ChangePasswordDto {
  // Deliberately not held to the password policy: this one is only ever
  // compared against the stored hash, and an existing password predates
  // whatever the policy says today. Validating it would leak "your current
  // password is weak" as a validation error before the bcrypt comparison
  // ever runs.
  @ApiProperty()
  @IsString()
  @MinLength(1)
  currentPassword: string;

  // Same bar as signup, accept-invite and reset-password — the policy lives
  // in the password-policy package and is referenced, never restated here,
  // so changing it changes every entry point at once.
  @ApiProperty()
  @IsString()
  @MinLength(12)
  @IsStrongPassword()
  newPassword: string;

  constructor(currentPassword: string, newPassword: string) {
    this.currentPassword = currentPassword;
    this.newPassword = newPassword;
  }
}
