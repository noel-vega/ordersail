import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  and,
  type db as Db,
  eq,
  isNull,
  ne,
  userRefreshTokensTable,
  usersTable,
} from 'db/identity';
import { FactorStateService } from './factor-state.service';

type DbTransaction = Parameters<Parameters<(typeof Db)['transaction']>[0]>[0];

// a just-rotated-out refresh token, re-presented within this window, replays
// the same replacement pair instead of revoking the family — see
// packages/db/src/schema/user-refresh-tokens.ts for why this exists
const REFRESH_GRACE_WINDOW_MS = 10_000;

// How long a Session survives without being used: the refresh token's
// lifetime, and — because the cookie helper imports this rather than keeping
// a literal of its own — the refresh cookie's maxAge too. In seconds, the
// unit both jsonwebtoken's numeric `expiresIn` and a cookie's `maxAge` take.
// See session-cookie.ts.
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

// How long an access token is good for once minted — and so the longest a
// revoked Session, a deactivated User or a stolen access token keeps working
// on the routes that don't read the database: nothing checks an access token
// against user_refresh_tokens, it simply runs out. 15 minutes, because being
// short costs nothing. merchant-web's root route refreshes on every
// navigation and the SDK refreshes on a 401, so a browser in use rarely
// presents a token more than a minute old; the lifetime only ever bites a
// token that ISN'T being refreshed, which is exactly the stolen or
// deactivated case. The price is paid outside a browser: anything holding a
// merchant access token there must be able to refresh, not mint once and
// reuse. In seconds, like REFRESH_TOKEN_TTL_SECONDS.
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 15;

// every refusal that concerns a token reads the same, so a caller can't tell
// a forged token from a revoked one from a deactivated User
const INVALID_TOKEN = 'Invalid or expired token';

// What a Session is handed out as. The refresh token belongs in the httpOnly
// cookie and nowhere else — see respondWithSession() in session-cookie.ts.
export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

// The access token's claims — only what has to be read without a database
// hit. `accountId` scopes every query; the two booleans gate every
// authenticated request (EmailVerifiedGuard, MfaEnrollmentGuard), so a claim
// beats a query per request, and remintAccessToken() keeps them fresh when
// they change mid-Session. Anything a person can edit — email, name — is
// deliberately NOT here: it is read from the User row where it's shown
// (AuthService.me), so an edit shows up at once instead of riding the token
// forward through every refresh. `typ` is an envelope field the signer adds.
//
// One object rather than positional parameters because it is mostly adjacent
// booleans: a transposed argument would type-check cleanly and silently mint
// a wrong auth claim.
interface AccessTokenClaims {
  sub: number;
  accountId: number;
  emailVerified: boolean;
  mfaEnrollmentSatisfied: boolean;
}

// The refresh token's whole payload: who, which user_refresh_tokens row, and
// the type marker. No claims and no personal data — it sits in a cookie for
// 7 days, and every claim is recomputed from the database when it's redeemed
// anyway, so anything copied in here could only ever be stale. Tokens minted
// before OS-527 carry more; the extra fields are simply never read.
interface RefreshTokenPayload {
  sub: number;
  jti: string;
  typ: 'refresh';
}

// The one place that knows what a Session is: how it begins (start), how it
// continues (refreshTokens, remintAccessToken) and how it ends (logout and
// the revoke* operations). The only code that reads or writes
// user_refresh_tokens, and the only signer of access and refresh tokens.
// Every input is a User id and/or the raw refresh cookie value — callers
// never decode a token, assemble a claim or see a family id.
@Injectable()
export class SessionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private jwtService: JwtService,
    private factorState: FactorStateService,
  ) {}

  // Starts a Session for a User who has just proved who they are. Every
  // sign-in path ends here — password sign-in with no Factor held, the
  // Factor challenge completions, passkey-only sign-in, signup,
  // accept-invite — and hands over the User id and nothing else. The row is
  // loaded, a missing or deactivated User is refused, and every claim is
  // computed from the database by claimsFor(), so a sign-in path cannot
  // forget a check: it doesn't perform any. That is what makes "a User
  // deactivated between the password and the Factor challenge gets no
  // Session" structural rather than something each path has to remember
  // (OS-504 found two that hadn't).
  //
  // The refusal is a bare 401 rather than INVALID_TOKEN: no token is
  // involved yet, and it reads the same as a wrong password — no oracle for
  // "this User was just switched off".
  async start(userId: number): Promise<TokenPair> {
    const claims = await this.claimsFor(userId);
    // A fresh family id is what makes this a new Session rather than the
    // continuation of one — see mintRefreshToken.
    const { token: refresh_token } = await this.mintRefreshToken(
      userId,
      randomUUID(),
    );
    return {
      access_token: await this.signAccessToken(claims),
      refresh_token,
    };
  }

  // A fresh access token for a caller whose claims just changed mid-Session
  // — email verified, first required Factor enrolled — so they aren't held
  // at a gate they have already cleared until their next refresh. Computed
  // from the database like every other mint, never by patching the token
  // they presented: that would carry its other claims forward unexamined
  // (a re-mint after enrolling a Factor used to copy a possibly stale
  // emailVerified this way). The refresh token is untouched; it carries no
  // claims to go stale.
  async remintAccessToken(userId: number): Promise<string> {
    return this.signAccessToken(await this.claimsFor(userId, INVALID_TOKEN));
  }

  // The session half of AuthService.changePassword, which calls this once
  // the new password is saved.
  //
  // EVERY live refresh token for this user is invalidated, the caller's
  // included. resetPassword already revokes unconditionally, and the usual
  // reason to change a password is believing it's compromised — leaving any
  // of them alive would make the self-service path weaker than the emailed
  // one. The threat this closes is a *copy* of the caller's own refresh
  // token: it lives in the caller's family, so merely sparing that family
  // would leave the attacker redeeming it for up to its full 7-day life.
  //
  // The caller still doesn't get signed out, because their family is rotated
  // rather than killed: the presented token is revoked and replaced in place,
  // exactly as an ordinary refresh does. Keeping the same family is what
  // preserves reuse detection — if the stolen copy is ever presented it hits
  // the replacedByJti path and takes the family down with it.
  async revokeOthersAndRotate(
    userId: number,
    callerRefreshToken: string | undefined,
  ): Promise<TokenPair> {
    const callersOwn = await this.callersLiveRefreshRecord(
      userId,
      callerRefreshToken,
    );

    // Spared here only so the rotation below can revoke-and-replace it; a
    // family killed outright has nothing left to rotate.
    await this.revokeAllFamiliesForUser(userId, callersOwn?.familyId);

    // No usable cookie (missing, expired, or already rotated out) leaves no
    // family to continue, so the caller starts a fresh Session. They asked
    // for this while holding a valid access token and just proved they know
    // the password, so signing them out instead would be a gratuitous
    // refusal.
    const rotated = callersOwn
      ? await this.rotateRefreshRecord(
          callersOwn,
          await this.claimsFor(userId, INVALID_TOKEN),
        )
      : null;
    if (rotated) {
      return rotated;
    }

    // A cookie that was live a moment ago and lost the rotation to a
    // concurrent refresh of the same token lands here too. The spared family
    // now holds a live successor this call didn't mint, and whoever redeemed
    // it may be the very copy this sweep exists to kill — so unlike
    // refreshTokens it must not replay that successor. The family dies with
    // the rest and the caller continues in a fresh one.
    if (callersOwn) {
      await this.revokeFamily(callersOwn.familyId);
    }

    return this.start(userId);
  }

  // "Sign out everywhere else" — the same sweep changePassword performs,
  // exposed on its own for someone who left a browser signed in somewhere
  // and doesn't want to rotate a password they still trust.
  //
  // The opposite intent to changePassword's, though: there the caller's own
  // family is spared only so it can be rotated (the threat being a *copy* of
  // their refresh token, which lives in that same family). Here nothing
  // suggests this browser's token is compromised, so its family is spared
  // and simply left running — no rotation, and so no new refresh cookie for
  // the controller to write back.
  //
  // Deliberately requires no password. Unlike disabling MFA or removing a
  // passkey, this only ever reduces access: the worst an attacker holding a
  // stolen access token achieves by calling it is signing the legitimate
  // user out, which is the very thing the legitimate user came here to do.
  //
  // No usable cookie (missing, expired, or already rotated out) leaves no
  // family to identify as "this one" — and that case is refused outright,
  // with nothing revoked. Both alternatives are worse. Revoking everything
  // signs out the one person who asked to stay. Revoking everything and then
  // starting the caller a fresh Session looks kind but breaks the paragraph
  // above: a bare access token, good for 15 minutes at most, would buy a
  // 7-day refresh token that rotates indefinitely, from an endpoint that is
  // only allowed to skip the password *because* it never grants anything.
  // changePassword does start a fresh Session on its own no-cookie path, but
  // it has verified the password by then; this has verified nothing.
  //
  // A browser essentially never gets here — the cookie is httpOnly, path "/",
  // and the SDK refreshes on a 401 — so the refusal lands on callers outside
  // one, which is exactly who shouldn't be handed a session.
  async revokeOtherSessions(
    userId: number,
    callerRefreshToken: string | undefined,
  ): Promise<void> {
    const callersOwn = await this.callersLiveRefreshRecord(
      userId,
      callerRefreshToken,
    );

    if (!callersOwn) {
      throw new ConflictException(
        "Couldn't tell which session is this one — sign in again, then retry",
      );
    }

    await this.revokeAllFamiliesForUser(userId, callersOwn.familyId);
  }

  // Ends every Session this User holds, on every browser, the caller's
  // included — for the moments nothing of theirs should survive. Two today:
  // AuthService.resetPassword (whoever prompted the reset is locked out
  // along with everyone else, and the User signs in again with the new
  // password) and UsersService.setDeactivated, which passes its transaction
  // so that "deactivated" and "holds no live Session" commit as one fact.
  async revokeAll(userId: number, tx?: DbTransaction): Promise<void> {
    await this.revokeAllFamiliesForUser(userId, null, tx);
  }

  // The caller's own live refresh-token row, or null if the cookie never
  // reached us, names a row that isn't theirs, or names one that's already
  // revoked.
  //
  // Liveness matters: a cookie that's already been rotated out names a dead
  // row, and treating that row's family as "this browser's" would spare its
  // live successor — the very session the caller may be here to kill. The
  // userId check is belt-and-braces (revokeAllFamiliesForUser filters on
  // userId anyway, so a foreign family id can't match), kept so a token
  // belonging to somebody else can never be the one that's rotated instead
  // of revoked.
  private async callersLiveRefreshRecord(
    userId: number,
    callerRefreshToken: string | undefined,
  ) {
    const presented = callerRefreshToken
      ? await this.refreshRecordFor(callerRefreshToken)
      : null;

    return presented && presented.userId === userId && !presented.revokedAt
      ? presented
      : null;
  }

  // `exceptFamilyId` holds one family back from the sweep — the caller's
  // own, so that a session which asked for this revocation isn't taken down
  // by the same statement that services it. What happens to the spared
  // family is the caller's business: changePassword rotates it (so it ends
  // up retired anyway, but with a successor), while a plain "sign out
  // everywhere" leaves it running as-is. A family id belonging to some other
  // user is harmless — the userId filter means it can't match, so this can
  // never spare a session it wasn't meant to.
  //
  // Private because a family id is how a Session is stored, not something a
  // caller should hold: the public forms take a User id and a cookie value.
  private async revokeAllFamiliesForUser(
    userId: number,
    exceptFamilyId?: string | null,
    tx?: DbTransaction,
  ): Promise<void> {
    await (tx ?? this.db)
      .update(userRefreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userRefreshTokensTable.userId, userId),
          isNull(userRefreshTokensTable.revokedAt),
          ...(exceptFamilyId
            ? [ne(userRefreshTokensTable.familyId, exceptFamilyId)]
            : []),
        ),
      );
  }

  private async sign(
    payload: Record<string, unknown>,
    expiresIn: JwtSignOptions['expiresIn'],
  ) {
    return await this.jwtService.signAsync(payload, { expiresIn });
  }

  private async signAccessToken(claims: AccessTokenClaims) {
    return await this.sign(
      { ...claims, typ: 'access' },
      ACCESS_TOKEN_TTL_SECONDS,
    );
  }

  private async signRefreshToken(userId: number, jti: string) {
    const payload: RefreshTokenPayload = { sub: userId, jti, typ: 'refresh' };
    return await this.sign({ ...payload }, REFRESH_TOKEN_TTL_SECONDS);
  }

  // Allocates a fresh jti, records it against `familyId`, and signs a token
  // for it. `familyId` is fresh (randomUUID()) for a brand-new Session
  // (start) and carried through unchanged on every rotation (refreshTokens)
  // — it's the unit reuse detection revokes as a whole.
  private async mintRefreshToken(
    userId: number,
    familyId: string,
  ): Promise<{ token: string; jti: string }> {
    const jti = randomUUID();
    await this.db
      .insert(userRefreshTokensTable)
      .values({ userId, jti, familyId });
    const token = await this.signRefreshToken(userId, jti);
    return { token, jti };
  }

  // The one function that decides what a token asserts: given a User id and
  // nothing else, every claim is computed from the database. Nothing is
  // carried over from a token the caller presented — deactivatedAt,
  // emailVerifiedAt, the Account and the Factor claim are all baked in at
  // mint time, so trusting a presented token would carry a stale answer
  // forward through every later one instead of picking up a change made
  // since. Every mint goes through here, which is also what refuses a
  // missing or deactivated User on every path at once.
  private async claimsFor(
    userId: number,
    refusal?: string,
  ): Promise<AccessTokenClaims> {
    const [userRow] = await this.db
      .select({
        accountId: usersTable.accountId,
        deactivatedAt: usersTable.deactivatedAt,
        emailVerifiedAt: usersTable.emailVerifiedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!userRow || userRow.deactivatedAt) {
      throw new UnauthorizedException(refusal);
    }

    return {
      sub: userId,
      accountId: userRow.accountId,
      emailVerified: userRow.emailVerifiedAt !== null,
      ...(await this.factorState.getFactorClaims(userId)),
    };
  }

  // Exchanges one live refresh-token row for its successor in the same
  // family: revoke the old row, point it at what replaces it, and insert
  // that replacement. That back-pointer is what the grace window and reuse
  // detection in refreshTokens() read, so nothing else may retire a row.
  //
  // Returns null when the row was no longer live by the time the write
  // landed — somebody else retired it first — and in that case writes
  // nothing. Every caller got here by reading the row as live, and that read
  // decides nothing: two concurrent redemptions both pass it. The UPDATE is
  // what decides, by being conditioned on isNull(revokedAt) — the same
  // conditional UPDATE ... RETURNING idiom as recovery codes and WebAuthn
  // challenges. Postgres serializes the two UPDATEs on the row; the second
  // re-evaluates its WHERE against the just-committed row, matches nothing,
  // and returning() comes back empty. Without the condition both would
  // rotate: the family forks into two live successors and the second write
  // overwrites replacedByJti, orphaning the first from reuse detection.
  //
  // Retire-then-insert, in one transaction, and both halves of that matter.
  // Retiring first means the loser never inserts a successor it would then
  // have to take back. One transaction means the loser — blocked on the row
  // until the winner commits — can't wake up to a replacedByJti that names a
  // row which doesn't exist yet: refreshTokens sends it straight into the
  // grace-window replay, which treats a missing replacement as reuse and
  // would kill the family the winner just rotated.
  //
  // Shared by the ordinary rotation (refreshTokens) and the forced one
  // (changePassword) so the two can't drift into different notions of what
  // rotating a session means.
  private async rotateRefreshRecord(
    record: { id: number; familyId: string },
    claims: AccessTokenClaims,
  ): Promise<TokenPair | null> {
    const nextJti = randomUUID();
    const won = await this.db.transaction(async (tx) => {
      const [retired] = await tx
        .update(userRefreshTokensTable)
        .set({ revokedAt: new Date(), replacedByJti: nextJti })
        .where(
          and(
            eq(userRefreshTokensTable.id, record.id),
            isNull(userRefreshTokensTable.revokedAt),
          ),
        )
        .returning();
      if (!retired) return false;

      await tx.insert(userRefreshTokensTable).values({
        userId: claims.sub,
        jti: nextJti,
        familyId: record.familyId,
      });
      return true;
    });
    if (!won) return null;

    return {
      access_token: await this.signAccessToken(claims),
      refresh_token: await this.signRefreshToken(claims.sub, nextJti),
    };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(userRefreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userRefreshTokensTable.familyId, familyId),
          isNull(userRefreshTokensTable.revokedAt),
        ),
      );
  }

  // Single-use: every call revokes the presented refresh token and issues a
  // fresh access+refresh pair in the same family. Presenting a token that's
  // already been rotated out is normally a theft signal — the legitimate
  // holder and an attacker holding a stolen copy can't both redeem the same
  // token, so whichever redeems second looks like reuse and kills the whole
  // family, forcing a real re-login rather than silently trusting either
  // side. The one exception is the grace window below, for concurrent
  // *legitimate* redemptions of the same token (two tabs, a retried
  // request) — see user-refresh-tokens.ts.
  async refreshTokens(refreshToken: string): Promise<TokenPair> {
    const payload = await this.verifyRefreshToken(refreshToken);
    if (!payload) {
      throw new UnauthorizedException(INVALID_TOKEN);
    }

    // a staff member deactivated mid-session still holds a valid 7-day
    // refresh token — claimsFor re-checks the row here so they can't keep
    // minting access tokens (gated routes already 403 them; this also cuts
    // off the authenticated-but-ungated ones), and recomputes the
    // emailVerified/factor claims so a change made since the last mint is
    // picked up at the next rotation
    const claims = await this.claimsFor(payload.sub, INVALID_TOKEN);

    let [record] = await this.db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, payload.jti));

    if (!record) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (!record.revokedAt) {
      const rotated = await this.rotateRefreshRecord(record, claims);
      if (rotated) {
        return rotated;
      }

      // Live when we read it, retired by the time we wrote: a concurrent
      // redemption of this same token won the rotation. That is the very
      // case the grace window exists for, so read the row again — it now
      // carries the winner's revokedAt and replacedByJti, committed together
      // with the successor they name — and fall through to the replay below
      // instead of minting a second successor.
      [record] = await this.db
        .select()
        .from(userRefreshTokensTable)
        .where(eq(userRefreshTokensTable.id, record.id));
    }

    if (record?.revokedAt) {
      const withinGrace =
        Date.now() - record.revokedAt.getTime() < REFRESH_GRACE_WINDOW_MS;

      if (withinGrace && record.replacedByJti) {
        const [replacement] = await this.db
          .select()
          .from(userRefreshTokensTable)
          .where(eq(userRefreshTokensTable.jti, record.replacedByJti));

        // the replacement is still the live token — replay the same pair
        // instead of rotating again, so a second concurrent request for
        // this same already-rotated token doesn't cause a second,
        // unnecessary rotation (or worse, get mistaken for reuse)
        if (replacement && !replacement.revokedAt) {
          return {
            access_token: await this.signAccessToken(claims),
            refresh_token: await this.signRefreshToken(
              claims.sub,
              replacement.jti,
            ),
          };
        }
      }

      // outside the grace window, or the replacement itself has since
      // moved on (more than one rotation stale) — real reuse signal
      await this.revokeFamily(record.familyId);
      throw new UnauthorizedException('Invalid or expired token');
    }

    // only reachable if the row vanished between the two reads above (rows
    // cascade with their User) — there is no session left to continue
    throw new UnauthorizedException('Invalid or expired token');
  }

  // The payload of a presented refresh token, or null if it isn't one: a bad
  // signature, an expired token, or — the check that matters most — a token
  // of another type. An access token carries a valid signature too; without
  // the `typ` test it would be redeemable here. Only sub/jti/typ are read,
  // so a token minted before OS-527 (which also carried the claim set) still
  // verifies and its extra fields are ignored.
  private async verifyRefreshToken(
    refreshToken: string,
  ): Promise<RefreshTokenPayload | null> {
    let payload: Partial<RefreshTokenPayload>;
    try {
      payload =
        await this.jwtService.verifyAsync<Partial<RefreshTokenPayload>>(
          refreshToken,
        );
    } catch {
      return null;
    }

    if (payload.typ !== 'refresh' || !payload.jti || !payload.sub) {
      return null;
    }
    return { sub: payload.sub, jti: payload.jti, typ: 'refresh' };
  }

  // The row a presented refresh token names, or null if it names none.
  // Deliberately total rather than throwing: both callers (logout,
  // changePassword) treat an invalid/expired/unknown token as "no session to
  // act on" rather than a user-facing failure. It does NOT judge whether the
  // token is still redeemable — a revoked row comes back as itself, and each
  // caller decides what that means (logout doesn't care; changePassword only
  // rotates a row that's still live).
  private async refreshRecordFor(refreshToken: string) {
    const payload = await this.verifyRefreshToken(refreshToken);
    if (!payload) {
      return null;
    }

    const [record] = await this.db
      .select()
      .from(userRefreshTokensTable)
      .where(eq(userRefreshTokensTable.jti, payload.jti));

    return record ?? null;
  }

  // Best-effort: an already-invalid/expired/unknown token is treated as a
  // no-op success, not an error — logging out with a stale token shouldn't
  // be a user-facing failure, since the end state ("this session is dead")
  // is the same either way.
  async logout(refreshToken: string): Promise<void> {
    const record = await this.refreshRecordFor(refreshToken);
    if (!record) {
      return;
    }

    await this.revokeFamily(record.familyId);
  }
}
