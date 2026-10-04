import { Reflector } from '@nestjs/core';
import {
  AUTHENTICATED_ONLY_KEY,
  PERMISSIONS_KEY,
} from 'src/shared/auth/decorators';
import { InventoryController } from './inventory/inventory.controller';
import { LocationsController } from './locations/locations.controller';

// OS-177 — every stock route carries an explicit @RequirePermissions key.
const reflector = new Reflector();
const perm = (controller: object, method: string): string[] | undefined =>
  reflector.get(
    PERMISSIONS_KEY,
    (controller as Record<string, () => unknown>)[method],
  );
const authenticatedOnly = (controller: object, method: string) =>
  reflector.get<boolean | undefined>(
    AUTHENTICATED_ONLY_KEY,
    (controller as Record<string, () => unknown>)[method],
  );

describe('stock RBAC (OS-177)', () => {
  it('gates inventory routes', () => {
    expect(perm(InventoryController.prototype, 'findAll')).toEqual([
      'inventory:read',
    ]);
    expect(perm(InventoryController.prototype, 'findMovements')).toEqual([
      'inventory:read',
    ]);
    expect(perm(InventoryController.prototype, 'createMovement')).toEqual([
      'inventory:write',
    ]);
  });

  it('gates location routes', () => {
    // listing locations is open to every staff member (@AuthenticatedOnly)
    expect(perm(LocationsController.prototype, 'findAll')).toBeUndefined();
    expect(authenticatedOnly(LocationsController.prototype, 'findAll')).toBe(
      true,
    );
    expect(perm(LocationsController.prototype, 'create')).toEqual([
      'locations:write',
    ]);
    expect(perm(LocationsController.prototype, 'update')).toEqual([
      'locations:write',
    ]);
  });

  it('gates location delete with locations:delete (OS-188)', () => {
    expect(perm(LocationsController.prototype, 'remove')).toEqual([
      'locations:delete',
    ]);
  });
});
