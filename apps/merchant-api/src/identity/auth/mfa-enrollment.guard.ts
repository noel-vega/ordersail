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
  SKIP_MFA_ENROLLMENT_KEY,
  type AuthenticatedRequest,
} from 'src/shared/auth/decorators';

// Deny-by-default (OS-473), same shape as EmailVerifiedGuard — blocks
// everything unless the route is @Public() (no request.user to check) or
// explicitly marked @SkipMfaEnrollment() (a route a caller needs to reach
// in order to enroll, or to check their own status). Reads the
// mfaEnrollmentSatisfied claim already on the JWT — no DB lookup per
// request.
@Injectable()
export class MfaEnrollmentGuard implements CanActivate {
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
      SKIP_MFA_ENROLLMENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skip) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user?.mfaEnrollmentSatisfied) {
      throw new ForbiddenException('MFA enrollment required');
    }

    return true;
  }
}

export const MFA_ENROLLMENT_APP_GUARD: Provider = {
  provide: APP_GUARD,
  useClass: MfaEnrollmentGuard,
};
