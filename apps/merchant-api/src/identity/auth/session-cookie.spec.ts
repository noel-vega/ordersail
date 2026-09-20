import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthController } from './auth.controller';
import { type AuthService } from './auth.service';
import { type AccessTokenDto } from './dto/access-token.dto';
import {
  REFRESH_TOKEN_TTL_SECONDS,
  type SessionsService,
  type TokenPair,
} from './sessions.service';
import { type UsersService } from '../users/users.service';

// The controller leg of a sign-in, which nothing used to cover: a handler
// that forgot the refresh cookie would have passed the whole suite. It is
// deliberately thin — the sign-in operations start the Session themselves
// (auth.service.spec, passkeys.service.spec), so all that is left for a
// controller to get wrong is the cookie, and every Session-bearing handler
// in both controllers writes it through the one helper exercised here.

const session: TokenPair = {
  access_token: 'the-access-token',
  refresh_token: 'the-refresh-token',
};

function reply() {
  const setCookie = jest.fn();
  const clearCookie = jest.fn();
  return {
    res: { setCookie, clearCookie } as unknown as FastifyReply,
    setCookie,
    clearCookie,
  };
}

// plain jest.fn()s rather than casts of the real classes, as in
// auth-me-profile.spec.ts
function build(authService: Partial<Record<keyof AuthService, jest.Mock>>) {
  const logout = jest.fn().mockResolvedValue(undefined);
  const controller = new AuthController(
    authService as unknown as AuthService,
    { logout } as unknown as SessionsService,
    {} as UsersService,
  );
  return { controller, logout };
}

const credentials = { email: 'dana@cactus.test', password: 'supersecret' };

describe('AuthController — the refresh cookie', () => {
  it('signin puts the refresh token in an httpOnly cookie that lives as long as the token, and only the access token in the body', async () => {
    const { controller } = build({
      signin: jest.fn().mockResolvedValue({ mfaRequired: false, ...session }),
    });
    const { res, setCookie } = reply();

    const body = await controller.signin(credentials, res);

    expect(setCookie).toHaveBeenCalledTimes(1);
    expect(setCookie).toHaveBeenCalledWith(
      'refresh_token',
      'the-refresh-token',
      {
        httpOnly: true,
        // NODE_ENV is 'test' here; production is the only place it's true
        secure: false,
        sameSite: 'lax',
        path: '/',
        maxAge: REFRESH_TOKEN_TTL_SECONDS,
      },
    );
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(body).toEqual({ access_token: 'the-access-token' });
  });

  // a password accepted with a Factor still owed is not a Session
  it('signin writes no cookie when the answer is a challenge', async () => {
    const challenge = {
      mfaRequired: true,
      challengeToken: 'the-challenge-token',
      methods: ['totp', 'recovery'],
    };
    const { controller } = build({
      signin: jest.fn().mockResolvedValue(challenge),
    });
    const { res, setCookie } = reply();

    await expect(controller.signin(credentials, res)).resolves.toEqual(
      challenge,
    );
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('logout ends the Session the cookie names and clears the cookie it was read from', async () => {
    const { controller, logout } = build({});
    const { res, clearCookie } = reply();
    const req = {
      cookies: { refresh_token: 'the-refresh-token' },
    } as unknown as FastifyRequest;

    await controller.logout(req, res);

    expect(logout).toHaveBeenCalledWith('the-refresh-token');
    expect(clearCookie).toHaveBeenCalledWith('refresh_token', { path: '/' });
  });

  // Type-level, checked by tsc and by ts-jest alike: an expect-error
  // directive that finds no error is itself an error, so this fails the day
  // a token pair becomes returnable from a handler typed
  // Promise<AccessTokenDto>.
  it('cannot hand a token pair back as a response body', () => {
    // @ts-expect-error — a TokenPair is not an AccessTokenDto
    const body: AccessTokenDto = session;
    expect(body).toBe(session);
  });
});
