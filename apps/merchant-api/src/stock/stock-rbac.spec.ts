import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from 'src/shared/auth/decorators';
import { InventoryController } from './inventory/inventory.controller';
import { LocationsController } from './locations/locations.controller';

// OS-177 — every stock route carries an explicit @RequirePermissions key.
const reflector = new Reflector();
const perm = (controller: object, method: string): string[] | undefined =>
  reflector.get(
    PERMISSIONS_KEY,
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
    expect(perm(LocationsController.prototype, 'findAll')).toEqual([
      'locations:read',
    ]);
    expect(perm(LocationsController.prototype, 'create')).toEqual([
      'locations:write',
    ]);
    expect(perm(LocationsController.prototype, 'update')).toEqual([
      'locations:write',
    ]);
  });
});
