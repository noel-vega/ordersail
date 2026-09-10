import { Reflector } from '@nestjs/core';
import { PERMISSIONS_CATALOG } from 'db/identity';
import { PERMISSIONS_KEY } from 'src/shared/auth/decorators';
import { CustomersController } from './customers.controller';

// OS-178 — customers are PII; GET /customers carries an explicit key and the
// catalog gains customers:read / customers:write.
const reflector = new Reflector();
const perm = (controller: object, method: string): string[] | undefined =>
  reflector.get(
    PERMISSIONS_KEY,
    (controller as Record<string, () => unknown>)[method],
  );

describe('customers RBAC (OS-178)', () => {
  it('gates GET /customers with customers:read', () => {
    expect(perm(CustomersController.prototype, 'findAll')).toEqual([
      'customers:read',
    ]);
  });

  it('adds customers:read + customers:write to the catalog', () => {
    const catalogKeys = PERMISSIONS_CATALOG.map((p) => p.key);
    expect(catalogKeys).toContain('customers:read');
    expect(catalogKeys).toContain('customers:write');
  });
});
