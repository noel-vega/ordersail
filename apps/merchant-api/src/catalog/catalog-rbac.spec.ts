import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from 'src/shared/auth/decorators';
import { ProductsController } from './products/products.controller';
import { BrandsController } from './brands/brands.controller';
import { CategoriesController } from './categories/categories.controller';

// OS-175 — every catalog route carries an explicit @RequirePermissions key so
// the global PermissionsGuard enforces it. Reflecting the metadata is enough to
// prove the decorator is applied; the owner-vs-limited 403 sweep is OS-182.
const reflector = new Reflector();

function perm(controller: object, method: string): string[] | undefined {
  return reflector.get(
    PERMISSIONS_KEY,
    (controller as Record<string, () => unknown>)[method],
  );
}

describe('catalog RBAC (OS-175)', () => {
  it('gates product reads with products:read', () => {
    for (const m of ['findAll', 'findOne', 'findVariants', 'findOptions']) {
      expect(perm(ProductsController.prototype, m)).toEqual(['products:read']);
    }
  });

  it('gates product writes with products:write', () => {
    for (const m of [
      'create',
      'update',
      'updateOption',
      'removeOption',
      'removeOptionValue',
      'createVariants',
      'updateVariant',
      'getImageUploadUrl',
      'createImage',
      'reorderImages',
      'removeImage',
    ]) {
      expect(perm(ProductsController.prototype, m)).toEqual(['products:write']);
    }
  });

  it('gates product delete with products:delete', () => {
    expect(perm(ProductsController.prototype, 'remove')).toEqual([
      'products:delete',
    ]);
  });

  it('folds brands + categories into products:*', () => {
    expect(perm(BrandsController.prototype, 'findAll')).toEqual([
      'products:read',
    ]);
    expect(perm(BrandsController.prototype, 'create')).toEqual([
      'products:write',
    ]);
    expect(perm(CategoriesController.prototype, 'findAll')).toEqual([
      'products:read',
    ]);
    expect(perm(CategoriesController.prototype, 'create')).toEqual([
      'products:write',
    ]);
  });

  it('gates brand update + delete with products:write (OS-186)', () => {
    expect(perm(BrandsController.prototype, 'update')).toEqual([
      'products:write',
    ]);
    expect(perm(BrandsController.prototype, 'remove')).toEqual([
      'products:write',
    ]);
  });
});
