import { ApiProperty } from '@nestjs/swagger';

export class UserRoleSummary {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty()
  name!: string;
}

// deliberately not `implements SelectUser` like Account/Location — the
// usersTable columns are firstname/lastname (see auth.service.ts signup,
// which maps firstName -> firstname by hand), but every other response in
// this API is camelCase, so the service maps rows onto this shape instead
// of passing them through. password is never included here.
export const USER_STATUSES = ['active', 'invited', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export class User {
  @ApiProperty({ type: Number })
  id!: number;

  @ApiProperty({ type: Number })
  accountId!: number;

  // derived: deactivatedAt set → 'deactivated'; else no password (a
  // pending invite) → 'invited'; else 'active'
  @ApiProperty({ enum: USER_STATUSES })
  status!: UserStatus;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ type: 'string', nullable: true })
  phone!: string | null;

  @ApiProperty()
  email!: string;

  @ApiProperty({ type: () => [UserRoleSummary] })
  roles!: UserRoleSummary[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
