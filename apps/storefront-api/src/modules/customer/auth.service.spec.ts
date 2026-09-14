import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { db as Db } from 'db';
import { AuthService } from './auth.service';
import type { AuthenticatedCustomer } from './auth.decorators';
import type { CustomerService } from './customer.service';
import type { CartService } from '../cart/cart.service';
import type { EmailService } from '../email/email.service';

function build(verifyAsync: (token: string) => Promise<AuthenticatedCustomer>) {
  const jwtService = {
    verifyAsync,
    signAsync: () => Promise.resolve('new-access-token'),
  } as unknown as JwtService;

  return new AuthService(
    {} as unknown as typeof Db,
    jwtService,
    {} as unknown as CustomerService,
    {} as unknown as CartService,
    {} as unknown as EmailService,
  );
}

const refreshPayload: AuthenticatedCustomer = {
  sub: 1,
  email: 'customer@buyer.test',
  accountId: 7,
  firstName: 'A',
  lastName: 'B',
  typ: 'refresh',
};

describe('AuthService.refreshAccessToken', () => {
  it('mints a new access token from a valid refresh token', async () => {
    const service = build(() => Promise.resolve(refreshPayload));

    await expect(service.refreshAccessToken('a-refresh-token')).resolves.toBe(
      'new-access-token',
    );
  });

  // OS-455: a token that verifies but isn't actually a refresh token (e.g.
  // an access token replayed here) must not be treated as one
  it('rejects a token whose typ is not "refresh"', async () => {
    const service = build(() =>
      Promise.resolve({ ...refreshPayload, typ: 'access' as const }),
    );

    await expect(
      service.refreshAccessToken('an-access-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an invalid or expired token', async () => {
    const service = build(() => {
      throw new Error('invalid token');
    });

    await expect(
      service.refreshAccessToken('bad-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
