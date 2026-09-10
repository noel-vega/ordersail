import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from 'src/shared/auth/decorators';
import { OrdersController } from './orders/orders.controller';
import { CartsController } from './carts/carts.controller';
import { FulfillmentsController } from './fulfillments/fulfillments.controller';
import { FailedOrdersController } from './failed-orders/failed-orders.controller';

// OS-176 — order reads, carts, and fulfillments carry an explicit
// @RequirePermissions key. Order writes + failed-orders were already gated.
const reflector = new Reflector();
const perm = (controller: object, method: string): string[] | undefined =>
  reflector.get(
    PERMISSIONS_KEY,
    (controller as Record<string, () => unknown>)[method],
  );

describe('sales RBAC (OS-176)', () => {
  it('gates order reads with orders:read and keeps the write gates', () => {
    expect(perm(OrdersController.prototype, 'findAll')).toEqual([
      'orders:read',
    ]);
    expect(perm(OrdersController.prototype, 'findOne')).toEqual([
      'orders:read',
    ]);
    expect(perm(OrdersController.prototype, 'updateStatus')).toEqual([
      'orders:write',
    ]);
    expect(perm(OrdersController.prototype, 'refund')).toEqual([
      'orders:refund',
    ]);
    expect(perm(OrdersController.prototype, 'cancel')).toEqual([
      'orders:cancel',
    ]);
  });

  it('folds carts into orders:read', () => {
    expect(perm(CartsController.prototype, 'findAll')).toEqual(['orders:read']);
    expect(perm(CartsController.prototype, 'findOne')).toEqual(['orders:read']);
  });

  it('gates fulfillments with fulfillments:write', () => {
    expect(perm(FulfillmentsController.prototype, 'getRates')).toEqual([
      'fulfillments:write',
    ]);
    expect(perm(FulfillmentsController.prototype, 'create')).toEqual([
      'fulfillments:write',
    ]);
  });

  it('leaves failed-orders on orders:read / orders:write', () => {
    expect(perm(FailedOrdersController.prototype, 'list')).toEqual([
      'orders:read',
    ]);
    expect(perm(FailedOrdersController.prototype, 'retry')).toEqual([
      'orders:write',
    ]);
  });
});
