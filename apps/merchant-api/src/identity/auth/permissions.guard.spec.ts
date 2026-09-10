import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  type AuthenticatedRequest,
} from 'src/shared/auth/decorators';
import {
  insertAccount,
  insertRole,
  insertUser,
  assignRole,
  seedPermissionsCatalog,
  useTestDb,
} from 'test-support';
import { PermissionsService } from '../permissions/permissions.service';
import { PermissionsGuard } from './permissions.guard';

const db = useTestDb();

// a minimal ExecutionContext carrying route metadata + a fake request. The
// guard only ever reads getHandler()/getClass() (fed to the Reflector) and
// switchToHttp().getRequest().
function ctx(opts: {
  required?: string[];
  isPublic?: boolean;
  user?: AuthenticatedRequest['user'];
}): { context: ExecutionContext; request: AuthenticatedRequest } {
  const handler = () => undefined;
  Reflect.defineMetadata(PERMISSIONS_KEY, opts.required, handler);
  if (opts.isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);

  const request: AuthenticatedRequest = { user: opts.user };
  const context = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function guard() {
  return new PermissionsGuard(new Reflector(), new PermissionsService(db));
}

// a user holding exactly `permissionKeys`, returns their `sub` (= user id)
async function userWith(permissionKeys: string[]): Promise<number> {
  await seedPermissionsCatalog(db);
  const account = await insertAccount(db);
  const user = await insertUser(db, { accountId: account.id });
  const role = await insertRole(db, { accountId: account.id, permissionKeys });
  await assignRole(db, { userId: user.id, roleId: role.id });
  return user.id;
}

const asUser = (sub: number): AuthenticatedRequest['user'] => ({
  sub,
  email: 'x@store.test',
  accountId: 1,
  firstName: 'X',
  lastName: 'Y',
});

describe('PermissionsGuard (OS-182)', () => {
  it('allows any route with no @RequirePermissions (opt-in)', async () => {
    const { context } = ctx({ required: undefined });
    await expect(guard().canActivate(context)).resolves.toBe(true);
  });

  it('allows a @Public() route even when it also carries a permission', async () => {
    const { context } = ctx({ required: ['orders:read'], isPublic: true });
    await expect(guard().canActivate(context)).resolves.toBe(true);
  });

  it('403s when request.user is missing on a gated route', async () => {
    const { context } = ctx({ required: ['orders:read'], user: undefined });
    await expect(guard().canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a user who holds the required key and stashes grantedPermissions', async () => {
    const sub = await userWith(['orders:read', 'orders:write']);
    const { context, request } = ctx({
      required: ['orders:read'],
      user: asUser(sub),
    });
    await expect(guard().canActivate(context)).resolves.toBe(true);
    expect(request.grantedPermissions?.has('orders:write')).toBe(true);
  });

  it('403s a limited user for a key they do not hold', async () => {
    const sub = await userWith(['orders:read']);
    const { context } = ctx({
      required: ['orders:write'],
      user: asUser(sub),
    });
    await expect(guard().canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('requires ALL keys when a route lists several', async () => {
    const sub = await userWith(['orders:read']);
    const { context } = ctx({
      required: ['orders:read', 'orders:refund'],
      user: asUser(sub),
    });
    await expect(guard().canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('grants an Owner (isSystem, post-backfill) everything', async () => {
    await seedPermissionsCatalog(db);
    const account = await insertAccount(db);
    const user = await insertUser(db, { accountId: account.id });
    const owner = await insertRole(db, {
      accountId: account.id,
      name: 'Owner',
      isSystem: true,
      permissionKeys: [],
    });
    await assignRole(db, { userId: user.id, roleId: owner.id });
    await new PermissionsService(db).onModuleInit(); // runs the backfill

    for (const key of ['orders:refund', 'products:delete', 'payments:write']) {
      const { context } = ctx({ required: [key], user: asUser(user.id) });
      await expect(guard().canActivate(context)).resolves.toBe(true);
    }
  });
});
