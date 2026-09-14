import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { AuthenticatedCustomer } from './auth.decorators';

// unlike merchant-api's AuthGuard (and this app's own AppKeyGuard), this is
// NOT a global APP_GUARD — storefront routes are public by default (guests
// must keep browsing/carting/checking out), so this is opted into per-route
// via @UseGuards() only where a signed-in customer is actually required
@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<
        Request & { accountId: number; customer?: AuthenticatedCustomer }
      >();

    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException();
    }

    let payload: AuthenticatedCustomer;
    try {
      payload = await this.jwtService.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }

    // AppKeyGuard (global) already resolved request.accountId from
    // x-app-key — a customer token issued by one merchant must not be
    // usable against a different merchant's app key
    if (payload.accountId !== request.accountId) {
      throw new UnauthorizedException();
    }

    request.customer = payload;
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
