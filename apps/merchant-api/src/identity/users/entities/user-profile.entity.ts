import { ApiProperty } from '@nestjs/swagger';

// The Profile aspect of a users row (ADR 0001): the self-editable attributes
// as the person themselves sees them, behind GET/PATCH /auth/me/profile.
//
// Deliberately narrower than User, which is the Staff record — roles, status,
// the invite lifecycle and accountId are the organization's view of the same
// row and stay behind users:read. Keeping the two shapes separate is what
// makes the ungated self endpoints safe to widen later: a field added here is
// a field the person may read about themselves, which is a different question
// from what an administrator may read about them.
//
// email is absent on purpose. It isn't editable (it's the sign-in identity),
// and the Profile page already has it from GET /auth/me, so repeating it here
// would give merchant-web two sources for one value.
export class UserProfile {
  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ type: 'string', nullable: true })
  phone!: string | null;
}
