import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  IS_PUBLIC_KEY,
  type AuthenticatedRequest,
} from 'src/shared/auth/decorators';
import { AuthGuard } from './auth.guard';

const jwt = new JwtService({ secret: 'test-secret' });

function ctx(opts: { authorization?: string; isPublic?: boolean }): {
  context: ExecutionContext;
  request: AuthenticatedRequest & {
    headers: Record<string, string | undefined>;
  };
} {
  const handler = () => undefined;
  if (opts.isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);

  const request = {
    headers: { authorization: opts.authorization },
    user: undefined,
  } as AuthenticatedRequest & { headers: Record<string, string | undefined> };
  const context = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function guard() {
  return new AuthGuard(jwt, new Reflector());
}

const payload = {
  sub: 1,
  email: 'x@store.test',
  accountId: 1,
  firstName: 'X',
  lastName: 'Y',
};

describe('AuthGuard typ enforcement (OS-467)', () => {
  it('allows a valid access token and stashes the payload on request.user', async () => {
    const token = await jwt.signAsync({ ...payload, typ: 'access' });
    const { context, request } = ctx({ authorization: `Bearer ${token}` });

    await expect(guard().canActivate(context)).resolves.toBe(true);
    expect(request.user?.sub).toBe(1);
  });

  // a refresh token shares the same signature/claims shape as an access
  // token except for `typ` — without this check it would work as a full
  // access token for its entire (much longer) lifetime
  it('rejects a refresh token presented as a bearer access token', async () => {
    const token = await jwt.signAsync({ ...payload, typ: 'refresh', jti: 'x' });
    const { context } = ctx({ authorization: `Bearer ${token}` });

    await expect(guard().canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('allows a @Public() route through with no token at all', async () => {
    const { context } = ctx({ isPublic: true });
    await expect(guard().canActivate(context)).resolves.toBe(true);
  });

  it('rejects a gated route with no token', async () => {
    const { context } = ctx({});
    await expect(guard().canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
