import fs from 'node:fs';
import path from 'node:path';
import { type Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CONTROLLER_WATERMARK,
  METHOD_METADATA,
} from '@nestjs/common/constants';
import { ApiKeysController } from '../api-keys/api-keys.controller';
import { PosDevicesController } from 'src/platform/pos-devices/pos-devices.controller';
import { StripeConnectController } from 'src/payments/stripe-connect.controller';
import {
  AUTHENTICATED_ONLY_KEY,
  NO_MFA_FACTOR_REQUIRED_KEY,
  REQUIRE_MFA_FACTOR_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
} from 'src/shared/auth/decorators';

// A safety net for the gap PermissionsGuard's own comment calls out: a
// route with none of @Public()/@RequirePermissions()/@AuthenticatedOnly()
// is reachable by any authenticated user with no permission check, and
// nothing enforces that a new route picks one. This is a static,
// metadata-only check — no DB, no app boot, no HTTP — so it's cheap enough
// to run on every PR. It catches a *missing* decorator; it can't prove the
// guard actually behaves correctly under a real request (that's OS-383's
// job, a separate runtime HTTP e2e RBAC sweep).
//
// Controllers are found by filesystem scan rather than a maintained list,
// so a brand-new controller file is covered automatically, not just new
// methods on an already-listed one.

const SRC_DIR = path.resolve(__dirname, '../..');

function findControllerFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true })
    .filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.endsWith('.controller.ts'),
    )
    .map((entry) => path.join(dir, entry));
}

interface RouteHandler {
  controllerFile: string;
  controllerName: string;
  methodName: string;
  handler: (...args: unknown[]) => unknown;
  // needed for markers applied at class level
  controllerClass: Type<unknown>;
}

function findRouteHandlers(files: string[]): RouteHandler[] {
  const routes: RouteHandler[] = [];

  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;

    for (const [exportName, exported] of Object.entries(mod)) {
      if (typeof exported !== 'function') continue;
      if (!Reflect.hasMetadata(CONTROLLER_WATERMARK, exported)) continue;

      const prototype = (exported as { prototype: object }).prototype;
      for (const methodName of Object.getOwnPropertyNames(prototype)) {
        if (methodName === 'constructor') continue;
        const handler = (prototype as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        // @Get()/@Post()/etc. write METHOD_METADATA on the handler itself —
        // this is what distinguishes an HTTP route from an ordinary helper
        // method on the controller class
        if (!Reflect.hasMetadata(METHOD_METADATA, handler)) continue;

        routes.push({
          controllerFile: path.relative(SRC_DIR, file),
          controllerName: exportName,
          methodName,
          handler: handler as (...args: unknown[]) => unknown,
          controllerClass: exported as Type<unknown>,
        });
      }
    }
  }

  return routes;
}

describe('route-guard coverage (OS-468)', () => {
  const reflector = new Reflector();
  const routes = findRouteHandlers(findControllerFiles(SRC_DIR));

  // guards against the scan itself silently finding nothing (e.g. a path
  // resolution mistake) and the suite below passing vacuously
  it('found route handlers to check', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it.each(routes)(
    '$controllerFile $controllerName.$methodName carries a guard marker',
    ({ handler }) => {
      const isPublic = reflector.get<boolean>(IS_PUBLIC_KEY, handler);
      const permissions = reflector.get<string[]>(PERMISSIONS_KEY, handler);
      const authenticatedOnly = reflector.get<boolean>(
        AUTHENTICATED_ONLY_KEY,
        handler,
      );

      const hasMarker =
        isPublic !== undefined ||
        permissions !== undefined ||
        authenticatedOnly !== undefined;

      expect(hasMarker).toBe(true);
    },
  );

  // OS-492. The gate is opt-in, so a new route says nothing by default and
  // silently isn't gated. This makes every route answer the question one way
  // or the other — the answer can be "no factor needed", but it has to be
  // written down.
  it.each(routes)(
    '$controllerFile $controllerName.$methodName declares whether it needs a factor',
    ({ handler, controllerClass }) => {
      const isPublic = reflector.get<boolean>(IS_PUBLIC_KEY, handler);
      if (isPublic) return;

      const handlerRequired = reflector.get<boolean>(
        REQUIRE_MFA_FACTOR_KEY,
        handler,
      );
      const handlerNotRequired = reflector.get<boolean>(
        NO_MFA_FACTOR_REQUIRED_KEY,
        handler,
      );

      // Both on the SAME handler is a contradiction. Class-level "not
      // required" alongside handler-level "required" is not — that's the
      // normal shape: a controller whose routes are unremarkable except one,
      // and the handler wins because the guard reads its key first.
      expect(handlerRequired && handlerNotRequired).toBeFalsy();

      const answered =
        handlerRequired !== undefined ||
        handlerNotRequired !== undefined ||
        reflector.get<boolean>(REQUIRE_MFA_FACTOR_KEY, controllerClass) !==
          undefined ||
        reflector.get<boolean>(NO_MFA_FACTOR_REQUIRED_KEY, controllerClass) !==
          undefined;

      expect(answered).toBe(true);
    },
  );
});

// Pins the POLICY, not just the coverage: the spec above is satisfied by any
// answer, so without this someone could quietly un-gate connecting Stripe
// and the suite would stay green.
describe('money and access actions require a factor (OS-492)', () => {
  const reflector = new Reflector();

  const handlerOf = (prototype: object, method: string) =>
    (prototype as Record<string, (...args: unknown[]) => unknown>)[method];

  const gated: [string, object, string][] = [
    ['ApiKeysController.create', ApiKeysController.prototype, 'create'],
    ['PosDevicesController.create', PosDevicesController.prototype, 'create'],
    [
      'PosDevicesController.rotatePairing',
      PosDevicesController.prototype,
      'rotatePairing',
    ],
    [
      'StripeConnectController.createOnboardingLink',
      StripeConnectController.prototype,
      'createOnboardingLink',
    ],
  ];

  it.each(gated)('%s requires a factor', (_name, prototype, method) => {
    expect(
      reflector.get<boolean>(
        REQUIRE_MFA_FACTOR_KEY,
        handlerOf(prototype, method),
      ),
    ).toBe(true);
  });

  // merchant-web initializes Connect.js on page load for a connected
  // merchant, so gating this would break the Payments page for someone who
  // never needed a factor — and it would fail inside Connect.js's opaque
  // error handling. createOnboardingLink is the gated money action.
  it('leaves the dual-use account-session ungated', () => {
    expect(
      reflector.get<boolean>(
        REQUIRE_MFA_FACTOR_KEY,
        handlerOf(StripeConnectController.prototype, 'createAccountSession'),
      ),
    ).toBeUndefined();
  });

  // De-escalations must never be gated: someone without a factor still has to
  // be able to revoke a leaked key or a stolen till.
  it.each([
    ['ApiKeysController.revoke', ApiKeysController.prototype, 'revoke'],
    ['PosDevicesController.revoke', PosDevicesController.prototype, 'revoke'],
  ])('%s stays ungated', (_name, prototype, method) => {
    expect(
      reflector.get<boolean>(
        REQUIRE_MFA_FACTOR_KEY,
        handlerOf(prototype, method),
      ),
    ).toBeUndefined();
  });
});
