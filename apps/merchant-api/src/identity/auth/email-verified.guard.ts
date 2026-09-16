import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Provider,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  SKIP_EMAIL_VERIFICATION_KEY,
  type AuthenticatedRequest,
} from 'src/shared/auth/decorators';

// Deny-by-default (OS-470) — the inverse of PermissionsGuard's opt-in
// shape. There are far more routes that should require a verified email
// than routes that shouldn't, so this blocks everything unless the route
// is @Public() (no request.user to check at all) or explicitly marked
// @SkipEmailVerification() (a route a caller needs to reach in order to
// get verified, or to sign out). Reads the `emailVerified` claim already
// on the JWT — no DB lookup per request, see AuthenticatedUser.
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_EMAIL_VERIFICATION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skip) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user?.emailVerified) {
      throw new ForbiddenException('Email verification required');
    }

    return true;
  }
}

export const EMAIL_VERIFIED_APP_GUARD: Provider = {
  provide: APP_GUARD,
  useClass: EmailVerifiedGuard,
};
