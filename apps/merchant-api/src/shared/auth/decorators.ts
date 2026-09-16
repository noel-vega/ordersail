import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'permissions';
// opt-in: a route with no @RequirePermissions() is unaffected by
// PermissionsGuard, regardless of what roles/permissions the caller has
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const AUTHENTICATED_ONLY_KEY = 'authenticatedOnly';
// a no-op marker — PermissionsGuard already lets through anything without
// @RequirePermissions(). Its only job is turning "deliberately reachable by
// any authenticated user, no specific permission required" into a
// checkable assertion instead of a code comment, so route-guard-coverage
// spec can tell "reviewed and intentional" apart from "nobody thought
// about this route's guard yet" (see identity/auth/route-guard-coverage.spec.ts)
export const AuthenticatedOnly = () =>
  SetMetadata(AUTHENTICATED_ONLY_KEY, true);

export interface AuthenticatedUser {
  sub: number;
  email: string;
  accountId: number;
  firstName: string;
  lastName: string;
  typ: 'access' | 'refresh';
  // only present on refresh tokens — identifies the user_refresh_tokens row
  // this specific token corresponds to (rotation/reuse-detection, OS-467)
  jti?: string;
}

// what AuthGuard / PermissionsGuard stash on the request object for
// downstream guards, decorators, and handlers to read back
export interface AuthenticatedRequest {
  user?: AuthenticatedUser;
  grantedPermissions?: Set<string>;
}

// AuthGuard stashes the verified JWT payload on request.user — this just
// pulls it out for handlers that need to attribute an action to a user
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    // AuthGuard runs first for every non-@Public() route and always sets this
    return request.user as AuthenticatedUser;
  },
);

// PermissionsGuard stashes the caller's full effective-permission set on
// request.grantedPermissions when a route has @RequirePermissions() — lets
// a handler reuse that instead of re-querying getEffectivePermissionKeys
// for an additional, narrower check on the same request
export const GrantedPermissions = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Set<string> | undefined => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.grantedPermissions;
  },
);
