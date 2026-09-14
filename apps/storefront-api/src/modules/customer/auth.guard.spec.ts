import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { CustomerAuthGuard } from './auth.guard';
import type { AuthenticatedCustomer } from './auth.decorators';

type FakeRequest = {
  headers: Record<string, string>;
  accountId: number;
  customer?: AuthenticatedCustomer;
};

function contextWithRequest(request: FakeRequest): {
  ctx: ExecutionContext;
  request: FakeRequest;
} {
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

function build(verifyAsync: (token: string) => Promise<AuthenticatedCustomer>) {
  return new CustomerAuthGuard({ verifyAsync } as unknown as JwtService);
}

const payload: AuthenticatedCustomer = {
  sub: 1,
  email: 'customer@buyer.test',
  accountId: 7,
  firstName: 'A',
  lastName: 'B',
  typ: 'access',
};

describe('CustomerAuthGuard', () => {
  it('allows a token whose accountId matches the request app-key accountId', async () => {
    const guard = build(() => Promise.resolve(payload));
    const { ctx, request } = contextWithRequest({
      headers: { authorization: 'Bearer good-token' },
      accountId: 7,
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.customer).toEqual(payload);
  });

  // OS-438: CORS can only confirm an Origin is registered by *some* account,
  // never that it belongs to *this* request's account — this is the
  // server-side check that actually closes the cross-tenant gap, by tying a
  // customer token to the account AppKeyGuard resolved for this request
  it("rejects a token issued for a different account than the request's app key", async () => {
    const guard = build(() => Promise.resolve(payload)); // payload.accountId === 7
    const { ctx } = contextWithRequest({
      headers: { authorization: 'Bearer good-token' },
      accountId: 999,
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a missing Authorization header', async () => {
    const guard = build(() => Promise.resolve(payload));
    const { ctx } = contextWithRequest({ headers: {}, accountId: 7 });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an invalid or expired token', async () => {
    const guard = build(() => {
      throw new Error('invalid token');
    });
    const { ctx } = contextWithRequest({
      headers: { authorization: 'Bearer bad-token' },
      accountId: 7,
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  // OS-455: access and refresh tokens share the same signature/claims shape
  // except `typ` — without this check, a leaked refresh token would work as
  // a full access token for its entire (much longer) lifetime
  it('rejects a refresh token presented as an access token', async () => {
    const guard = build(() =>
      Promise.resolve({ ...payload, typ: 'refresh' as const }),
    );
    const { ctx } = contextWithRequest({
      headers: { authorization: 'Bearer refresh-token' },
      accountId: 7,
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
