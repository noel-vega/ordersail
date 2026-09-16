import { Reflector } from '@nestjs/core';
import { PERMISSIONS_CATALOG } from 'db/identity';
import {
  AUTHENTICATED_ONLY_KEY,
  PERMISSIONS_KEY,
} from 'src/shared/auth/decorators';
import { DashboardController } from './dashboard/dashboard.controller';
import { OnboardingController } from './onboarding/onboarding.controller';

// OS-468 — GET /dashboard was previously ungated (reachable by any
// authenticated staffer regardless of role) with no comment explaining
// that as intentional, unlike the app's other ungated routes. Treated as
// an oversight: gated behind dashboard:read. GET /onboarding/status stays
// ungated on purpose (it backs the always-visible home page), now marked
// explicit via @AuthenticatedOnly() instead of a bare comment.
const reflector = new Reflector();
const perm = (controller: object, method: string): string[] | undefined =>
  reflector.get(
    PERMISSIONS_KEY,
    (controller as Record<string, () => unknown>)[method],
  );
const authenticatedOnly = (controller: object, method: string): boolean =>
  reflector.get(
    AUTHENTICATED_ONLY_KEY,
    (controller as Record<string, () => unknown>)[method],
  ) === true;

describe('platform RBAC (OS-468)', () => {
  it('gates the dashboard summary with dashboard:read', () => {
    expect(perm(DashboardController.prototype, 'getSummary')).toEqual([
      'dashboard:read',
    ]);
  });

  it('leaves onboarding status explicitly authenticated-only', () => {
    expect(authenticatedOnly(OnboardingController.prototype, 'getStatus')).toBe(
      true,
    );
  });

  it('adds dashboard:read to the catalog', () => {
    expect(PERMISSIONS_CATALOG.map((p) => p.key)).toContain('dashboard:read');
  });
});
