import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AUTHENTICATED_ONLY_KEY,
  PERMISSIONS_KEY,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

// OS-384 — the Profile aspect of /auth/me (ADR 0001). The claim worth
// pinning is that these routes can only ever reach the caller's own row:
// they take no id, so the only thing standing between them and someone
// else's Profile is that the handler reads user.sub. A spec is the cheapest
// way to keep it that way, since nothing in the type system would notice a
// @Param('id') creeping in later.

const user: AuthenticatedUser = {
  sub: 7,
  email: 'dana@fbi.test',
  accountId: 3,
  firstName: 'Dana',
  lastName: 'Scully',
  emailVerified: true,
  mfaEnrollmentSatisfied: true,
  typ: 'access',
};

const profile = { firstName: 'Dana', lastName: 'Scully', phone: null };

// plain jest.fn()s rather than casts of the real classes, matching
// account.controller.spec.ts — assertions then read as ordinary mocks
// instead of unbound class methods
function build() {
  const getProfile = jest.fn().mockResolvedValue(profile);
  const updateProfile = jest.fn().mockResolvedValue(profile);
  const controller = new AuthController(
    {} as AuthService,
    {
      getProfile,
      updateProfile,
    } as unknown as UsersService,
  );
  return { controller, getProfile, updateProfile };
}

describe('AuthController /auth/me/profile (OS-384)', () => {
  it('reads the caller own row, scoped to their account', async () => {
    const { controller, getProfile } = build();

    await expect(controller.profile(user)).resolves.toEqual(profile);
    expect(getProfile).toHaveBeenCalledWith(7, 3);
  });

  it('writes the caller own row, scoped to their account', async () => {
    const { controller, updateProfile } = build();

    await expect(
      controller.updateProfile(user, { firstName: 'Katherine' }),
    ).resolves.toEqual(profile);
    expect(updateProfile).toHaveBeenCalledWith(7, 3, {
      firstName: 'Katherine',
    });
  });

  // an access token lives 8h, so it outlives a user deleted mid-session
  // (a revoked invite, say) — that has to be a 404, not a 500 from
  // returning undefined out of a non-nullable handler
  it.each([
    ['profile', (c: AuthController) => c.profile(user)],
    ['updateProfile', (c: AuthController) => c.updateProfile(user, {})],
  ])('%s 404s when the row behind the token is gone', async (_name, call) => {
    const { controller, getProfile, updateProfile } = build();
    getProfile.mockResolvedValue(undefined);
    updateProfile.mockResolvedValue(undefined);

    await expect(call(controller)).rejects.toBeInstanceOf(NotFoundException);
  });
});

// The static-metadata seam. route-guard-coverage.spec.ts already insists
// every route declares *something*; this pins which answer, so nobody can
// quietly put a permission key on a route whose whole point is being
// reachable by a user who holds none.
describe('/auth/me/profile RBAC (OS-384)', () => {
  const reflector = new Reflector();
  const handlerOf = (method: string) =>
    (AuthController.prototype as unknown as Record<string, () => unknown>)[
      method
    ];

  it.each(['profile', 'updateProfile'])(
    '%s is authenticated-only with no permission key',
    (method) => {
      expect(
        reflector.get<boolean>(AUTHENTICATED_ONLY_KEY, handlerOf(method)),
      ).toBe(true);
      expect(
        reflector.get<string[]>(PERMISSIONS_KEY, handlerOf(method)),
      ).toBeUndefined();
    },
  );
});
