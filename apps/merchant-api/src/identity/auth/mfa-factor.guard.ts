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
  REQUIRE_MFA_FACTOR_KEY,
  type AuthenticatedRequest,
} from 'src/shared/auth/decorators';

// Allow-by-default with opt-ins, the same polarity as PermissionsGuard —
// and deliberately NOT folded into MfaEnrollmentGuard, which is
// deny-by-default with opt-outs. Two opposite polarities in one guard is
// where the bugs live, and keeping them apart leaves that guard's spec
// untouched.
//
// It also answers a different question. MfaEnrollmentGuard asks "is anything
// blocking this user", which is trivially true on an account that doesn't
// require MFA. This asks "do they hold a factor at all", which is the bar
// that matters before connecting a bank account or minting an API key.
@Injectable()
export class MfaFactorGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_MFA_FACTOR_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user?.hasMfaFactor) {
      // The `code` is the point: merchant-web has to tell this apart from a
      // permission denial to offer setting a factor up, and a message alone
      // can only be matched by string comparison (see merchant-sdk's do()).
      throw new ForbiddenException({
        message: 'A passkey or authenticator app is required for this action',
        code: 'MFA_FACTOR_REQUIRED',
      });
    }

    return true;
  }
}

export const MFA_FACTOR_APP_GUARD: Provider = {
  provide: APP_GUARD,
  useClass: MfaFactorGuard,
};
