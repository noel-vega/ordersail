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

export const SKIP_EMAIL_VERIFICATION_KEY = 'skipEmailVerification';
// opt-out, inverted from @RequirePermissions()'s opt-in: EmailVerifiedGuard
// blocks every route by default for an unverified caller, since there are
// far more routes that should require verification than routes that
// shouldn't. This marks the few exceptions — a caller needs to reach them
// *in order to* get verified (or to sign out) in the first place. @Public()
// routes are already exempt (EmailVerifiedGuard never runs without a
// request.user to check); this is only for authenticated-but-unverified
// routes like GET /auth/me and POST /auth/verify-email/resend.
export const SkipEmailVerification = () =>
  SetMetadata(SKIP_EMAIL_VERIFICATION_KEY, true);

export const SKIP_MFA_ENROLLMENT_KEY = 'skipMfaEnrollment';
// opt-out, same shape as @SkipEmailVerification() — MfaEnrollmentGuard
// blocks every route by default when the caller's account requires MFA and
// they haven't confirmed a factor yet (OS-473). This marks the few routes a
// caller needs to reach *in order to* enroll (or to check their own status).
export const SkipMfaEnrollment = () =>
  SetMetadata(SKIP_MFA_ENROLLMENT_KEY, true);

export const REQUIRE_MFA_FACTOR_KEY = 'requireMfaFactor';
// opt-in, like @RequirePermissions(): marks an action where holding a second
// factor is the bar, not just being signed in (OS-492). Money and account
// access — connecting Stripe, pairing a POS device, minting an API key.
//
// Deliberately NOT the same question as MfaEnrollmentGuard's. That one asks
// "is anything blocking this user", which is trivially satisfied on an
// account that doesn't require MFA. This asks "do they actually hold a
// factor", which is what matters before something irreversible.
export const RequireMfaFactor = () => SetMetadata(REQUIRE_MFA_FACTOR_KEY, true);

export const NO_MFA_FACTOR_REQUIRED_KEY = 'noMfaFactorRequired';
// The counterpart no-op marker, same job as @AuthenticatedOnly(): the guard
// never reads it. It exists so route-guard-coverage.spec can require every
// route to answer the question one way or the other, turning "this action
// doesn't need a factor" into a checkable assertion rather than silence.
//
// Applied at CLASS level on controllers whose routes are all unremarkable —
// a handler-level @RequireMfaFactor() still wins, because getAllAndOverride
// looks up a different metadata key.
export const NoMfaFactorRequired = () =>
  SetMetadata(NO_MFA_FACTOR_REQUIRED_KEY, true);

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
  // baked in at mint time rather than looked up from the DB per request
  // (OS-470) — mirrors how deactivatedAt is only re-checked at refresh
  // time, not per access-token call. Set true again by re-minting the pair
  // in verify-email/accept-invite, not by mutating an existing token.
  emailVerified: boolean;
  // true when the caller's account doesn't require MFA, or does and they
  // have a confirmed factor — i.e. "nothing is blocking them" (OS-473).
  // Same baked-in-at-mint-time, recomputed-on-refresh treatment as
  // emailVerified. A caller who enrolls mid-session gets this flipped true
  // immediately via a token re-mint in AuthService.confirmMfa, rather than
  // waiting for their next refresh.
  mfaEnrollmentSatisfied: boolean;
  // true when the caller holds ANY second factor — a confirmed TOTP row or
  // at least one passkey (OS-484). Distinct from mfaEnrollmentSatisfied,
  // which asks whether anything is *blocking* them: a user on an account
  // that doesn't require MFA is satisfied with no factor at all. Read by
  // MfaFactorGuard to gate money/access-sensitive actions (OS-492).
  hasMfaFactor: boolean;
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
