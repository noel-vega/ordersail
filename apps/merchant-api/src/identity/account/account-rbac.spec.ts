import { Reflector } from '@nestjs/core';
import { PERMISSIONS_CATALOG } from 'db/identity';
import { PERMISSIONS_KEY } from 'src/shared/auth/decorators';
import { AccountController } from './account.controller';
import { StripeConnectController } from 'src/payments/stripe-connect.controller';
import { PosDevicesController } from 'src/platform/pos-devices/pos-devices.controller';

// OS-179 — account, stripe-connect, and pos-devices routes carry explicit keys;
// the catalog gains pos_devices:* and payments:*.
const reflector = new Reflector();
const perm = (controller: object, method: string): string[] | undefined =>
  reflector.get(
    PERMISSIONS_KEY,
    (controller as Record<string, () => unknown>)[method],
  );

describe('account / payments / pos-devices RBAC (OS-179)', () => {
  it('gates account routes', () => {
    expect(perm(AccountController.prototype, 'findOne')).toEqual([
      'account:read',
    ]);
    expect(perm(AccountController.prototype, 'update')).toEqual([
      'account:write',
    ]);
  });

  it('gates stripe-connect routes', () => {
    expect(perm(StripeConnectController.prototype, 'getStatus')).toEqual([
      'payments:read',
    ]);
    expect(
      perm(StripeConnectController.prototype, 'createAccountSession'),
    ).toEqual(['payments:write']);
  });

  it('gates pos-devices routes', () => {
    expect(perm(PosDevicesController.prototype, 'findAll')).toEqual([
      'pos_devices:read',
    ]);
    for (const m of ['create', 'update', 'revoke', 'rotatePairing']) {
      expect(perm(PosDevicesController.prototype, m)).toEqual([
        'pos_devices:write',
      ]);
    }
  });

  it('adds pos_devices:* and payments:* to the catalog', () => {
    const keys = PERMISSIONS_CATALOG.map((p) => p.key);
    for (const k of [
      'pos_devices:read',
      'pos_devices:write',
      'payments:read',
      'payments:write',
    ]) {
      expect(keys).toContain(k);
    }
  });
});
