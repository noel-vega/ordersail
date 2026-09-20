import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { type AuthenticatedUser } from 'src/shared/auth/decorators';
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
import { type TokenClaims } from './token-claims';

// a just-rotated-out refresh token, re-presented within this window, replays
// the same replacement pair instead of revoking the family — see
// packages/db/src/schema/user-refresh-tokens.ts for why this exists
const REFRESH_GRACE_WINDOW_MS = 10_000;

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private jwtService: JwtService,
    private factorState: FactorStateService,
  ) {}

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
    caller: AuthenticatedUser,
    callerRefreshToken: string | undefined,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const callersOwn = await this.callersLiveRefreshRecord(
      caller.sub,
      callerRefreshToken,
    );

    // Spared here only so the rotation below can revoke-and-replace it; a
    // family killed outright has nothing left to rotate.
    await this.revokeAllFamiliesForUser(caller.sub, callersOwn?.familyId);

    // Recomputed from the database rather than copied off the access token
    // the caller presented, for the same reason refreshTokens does it.
    const claims = await this.freshClaims(caller);

    // No usable cookie (missing, expired, or already rotated out) leaves no
    // family to continue, so the caller starts a fresh one. They asked for
    // this while holding a valid access token and just proved they know the
    // password, so signing them out instead would be a gratuitous refusal.
    const rotated = callersOwn
      ? await this.rotateRefreshRecord(callersOwn, claims)
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

    return {
      access_token: await this.createAccessToken(claims),
      refresh_token: await this.createRefreshToken(claims, randomUUID()),
    };
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
  // starting the caller a fresh family looks kind but breaks the paragraph
  // above: a bare access token, good for 8h at most, would buy a 7-day
  // refresh token that rotates indefinitely, from an endpoint that is only
  // allowed to skip the password *because* it never grants anything.
  // changePassword does start a fresh family on its own no-cookie path, but
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
  // Public because AuthService.resetPassword ends with the unconditional
  // form of this sweep (no family spared).
  async revokeAllFamiliesForUser(
    userId: number,
    exceptFamilyId?: string | null,
  ): Promise<void> {
    await this.db
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

  async createAccessToken(claims: TokenClaims) {
    return await this.sign({ ...claims, typ: 'access' }, '8h');
  }

  private async signRefreshToken(claims: TokenClaims, jti: string) {
    return await this.sign({ ...claims, typ: 'refresh', jti }, '7d');
  }

  // Allocates a fresh jti, records it against `familyId`, and signs a token
  // for it. `familyId` is fresh (randomUUID()) for a brand-new session
  // (signin/signup/accept-invite, see AuthController) and carried through
  // unchanged on every rotation (refreshTokens) — it's the unit reuse
  // detection revokes as a whole.
  private async mintRefreshToken(
    claims: TokenClaims,
    familyId: string,
  ): Promise<{ token: string; jti: string }> {
    const jti = randomUUID();
    await this.db
      .insert(userRefreshTokensTable)
      .values({ userId: claims.sub, jti, familyId });
    const token = await this.signRefreshToken(claims, jti);
    return { token, jti };
  }

  async createRefreshToken(
    claims: TokenClaims,
    familyId: string,
  ): Promise<string> {
    const { token } = await this.mintRefreshToken(claims, familyId);
    return token;
  }

  // The claim set for a caller, recomputed against the database rather than
  // carried over from whatever token they presented. deactivatedAt,
  // emailVerifiedAt and the factor claims are all baked in at mint time, so
  // trusting the presented token would carry a stale answer forward through
  // every later token instead of picking up a change made since.
  //
  // Only the identity fields ride along from `identity` — those can't drift
  // without a re-mint anyway.
  private async freshClaims(identity: AuthenticatedUser): Promise<TokenClaims> {
    const [userRow] = await this.db
      .select({
        deactivatedAt: usersTable.deactivatedAt,
        emailVerifiedAt: usersTable.emailVerifiedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, identity.sub));
    if (!userRow || userRow.deactivatedAt) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return {
      sub: identity.sub,
      email: identity.email,
      accountId: identity.accountId,
      firstName: identity.firstName,
      lastName: identity.lastName,
      emailVerified: userRow.emailVerifiedAt !== null,
      ...(await this.factorState.getFactorClaims(identity.sub)),
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
    claims: TokenClaims,
  ): Promise<{ access_token: string; refresh_token: string } | null> {
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
      access_token: await this.createAccessToken(claims),
      refresh_token: await this.signRefreshToken(claims, nextJti),
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
  async refreshTokens(
    refreshToken: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    let payload: AuthenticatedUser;
    try {
      payload =
        await this.jwtService.verifyAsync<AuthenticatedUser>(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload.typ !== 'refresh' || !payload.jti) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // a staff member deactivated mid-session still holds a valid 7-day
    // refresh token — freshClaims re-checks the row here so they can't keep
    // minting access tokens (gated routes already 403 them; this also cuts
    // off the authenticated-but-ungated ones), and recomputes the
    // emailVerified/factor claims rather than carrying the presented
    // token's stale answers forward through every future rotation
    const claims = await this.freshClaims(payload);

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
            access_token: await this.createAccessToken(claims),
            refresh_token: await this.signRefreshToken(claims, replacement.jti),
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

  // The row a presented refresh token names, or null if it names none.
  // Deliberately total rather than throwing: both callers (logout,
  // changePassword) treat an invalid/expired/unknown token as "no session to
  // act on" rather than a user-facing failure. It does NOT judge whether the
  // token is still redeemable — a revoked row comes back as itself, and each
  // caller decides what that means (logout doesn't care; changePassword only
  // rotates a row that's still live).
  private async refreshRecordFor(refreshToken: string) {
    let payload: AuthenticatedUser;
    try {
      payload =
        await this.jwtService.verifyAsync<AuthenticatedUser>(refreshToken);
    } catch {
      return null;
    }

    if (payload.typ !== 'refresh' || !payload.jti) {
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
