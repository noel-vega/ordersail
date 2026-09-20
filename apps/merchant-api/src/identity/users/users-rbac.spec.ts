import { Reflector } from '@nestjs/core';
import { PERMISSIONS_CATALOG } from 'db/identity';
import { PERMISSIONS_KEY } from 'src/shared/auth/decorators';
import { UsersController } from './users.controller';

// OS-184 — the staff detail routes carry explicit keys; the catalog gains
// users:deactivate. Every route here is administrative: since OS-384 the
// self cases live at /auth/me/profile instead, so no route on this
// controller carries an exception for the caller editing themselves.
const reflector = new Reflector();
const perm = (controller: object, method: string): string[] | undefined =>
  reflector.get(
    PERMISSIONS_KEY,
    (controller as Record<string, () => unknown>)[method],
  );

describe('users RBAC (OS-184)', () => {
  it('gates the read + lifecycle routes', () => {
    expect(perm(UsersController.prototype, 'findAll')).toEqual(['users:read']);
    expect(perm(UsersController.prototype, 'findOne')).toEqual(['users:read']);
    expect(perm(UsersController.prototype, 'create')).toEqual(['users:write']);
    expect(perm(UsersController.prototype, 'updateRoles')).toEqual([
      'users:manage_roles',
    ]);
    expect(perm(UsersController.prototype, 'deactivate')).toEqual([
      'users:deactivate',
    ]);
    expect(perm(UsersController.prototype, 'reactivate')).toEqual([
      'users:deactivate',
    ]);
  });

  it('gates the invite lifecycle routes with users:write (OS-185)', () => {
    expect(perm(UsersController.prototype, 'resendInvite')).toEqual([
      'users:write',
    ]);
    expect(perm(UsersController.prototype, 'revokeInvite')).toEqual([
      'users:write',
    ]);
  });

  // OS-384: this route used to be @AuthenticatedOnly() with an in-handler
  // "id === user.sub is always allowed" branch. Asserting the key here is
  // what stops the hole being reopened — the self path is /auth/me/profile.
  it('gates PATCH /users/:id with users:write, with no self-exception (OS-384)', () => {
    expect(perm(UsersController.prototype, 'update')).toEqual(['users:write']);
  });

  it('adds users:deactivate to the catalog', () => {
    expect(PERMISSIONS_CATALOG.map((p) => p.key)).toContain('users:deactivate');
  });
});
