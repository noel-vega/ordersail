import { Reflector } from '@nestjs/core';
import { PERMISSIONS_CATALOG } from 'db/identity';
import { PERMISSIONS_KEY } from 'src/shared/auth/decorators';
import { UsersController } from './users.controller';

// OS-184 — the staff detail routes carry explicit keys; the catalog gains
// users:deactivate. PATCH /users/:id is deliberately ungated (self-edit is
// always allowed; editing others is checked in the handler).
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

  it('leaves PATCH /users/:id ungated (self-edit handled in the handler)', () => {
    expect(perm(UsersController.prototype, 'update')).toBeUndefined();
  });

  it('adds users:deactivate to the catalog', () => {
    expect(PERMISSIONS_CATALOG.map((p) => p.key)).toContain('users:deactivate');
  });
});
