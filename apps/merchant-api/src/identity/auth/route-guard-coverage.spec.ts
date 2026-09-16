import fs from 'node:fs';
import path from 'node:path';
import { Reflector } from '@nestjs/core';
import {
  CONTROLLER_WATERMARK,
  METHOD_METADATA,
} from '@nestjs/common/constants';
import {
  AUTHENTICATED_ONLY_KEY,
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
});
