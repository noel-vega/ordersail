import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from 'src/shared/env';
import { AccessTokenDto } from './dto/access-token.dto';
import { REFRESH_TOKEN_TTL_SECONDS, type TokenPair } from './sessions.service';

// The HTTP side of a Session: the refresh cookie's name, flags and lifetime,
// owned in one place and used by both AuthController and PasskeysController.
// Three plain functions a handler calls by name, deliberately not an
// interceptor — on a security-sensitive response, explicit and greppable
// beats action at a distance.

const REFRESH_TOKEN_COOKIE = 'refresh_token';

// Finishes any handler that was handed a Session: the refresh token goes
// into the cookie, and ONLY the access token comes back for the body. A
// handler returns what this returns, and is typed Promise<AccessTokenDto>,
// so there is no path by which the refresh token reaches a response body
// short of writing one out by hand — and forgetting the cookie means having
// no AccessTokenDto to return.
export function respondWithSession(
  res: FastifyReply,
  session: TokenPair,
): AccessTokenDto {
  res.setCookie(REFRESH_TOKEN_COOKIE, session.refresh_token, {
    httpOnly: true, // Prevents client-side JS from accessing the cookie
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax', // Helps protect against CSRF attacks
    path: '/', // Scopes the cookie to the entire domain
    // the same constant the refresh token's own expiry is signed with, so
    // the cookie and the token it carries can't disagree about when the
    // Session goes idle
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
  return { access_token: session.access_token };
}

// The raw cookie value, for SessionsService to make sense of — a controller
// never decodes it.
export function readSessionCookie(req: FastifyRequest): string | undefined {
  return req.cookies[REFRESH_TOKEN_COOKIE];
}

// refresh_token is httpOnly, so it can only be cleared by the server — the
// client can't just delete it itself
export function clearSessionCookie(res: FastifyReply): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });
}
