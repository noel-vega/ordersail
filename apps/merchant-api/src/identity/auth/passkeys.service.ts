import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import {
  accountsTable,
  and,
  type db as Db,
  eq,
  gt,
  isNull,
  isUniqueViolation,
  lt,
  userPasskeysTable,
  usersTable,
  webauthnChallengesTable,
} from 'db/identity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { type AuthenticatedUser } from 'src/shared/auth/decorators';
import { AuthService, type SignInSuccessResult } from './auth.service';
import { claimsFromUser } from './token-claims';
import { PasskeyDto } from './dto/passkey.dto';
import { WEBAUTHN_CHALLENGE_TTL_MS, webauthnConfig } from './webauthn.config';

export type WebauthnChallengeType = 'registration' | 'authentication';

@Injectable()
export class PasskeysService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private readonly authService: AuthService,
  ) {}

  async list(userId: number): Promise<PasskeyDto[]> {
    const rows = await this.db
      .select()
      .from(userPasskeysTable)
      .where(eq(userPasskeysTable.userId, userId));
    return rows.map(toPasskeyDto);
  }

  async getRegistrationOptions(
    userId: number,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const [user] = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!user) throw new UnauthorizedException();

    // Same bar as enrollMfa (OS-470): don't let anyone lock in a second
    // factor before they've proven they can read the inbox that recovery
    // would go through.
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Verify your email before adding a passkey');
    }

    const existing = await this.db
      .select()
      .from(userPasskeysTable)
      .where(eq(userPasskeysTable.userId, userId));

    const options = await generateRegistrationOptions({
      rpName: webauthnConfig.rpName,
      rpID: webauthnConfig.rpID,
      userName: user.email,
      // the opaque per-user handle, never user.id — see users.webauthnHandle
      userID: isoUint8Array.fromUTF8String(user.webauthnHandle),
      userDisplayName: `${user.firstname} ${user.lastname}`,
      // we don't verify attestation, so don't ask the authenticator for it:
      // requesting it prompts the user on some platforms for data we throw
      // away
      attestationType: 'none',
      // lets the authenticator say "you already have one of these here"
      // instead of silently registering a duplicate
      excludeCredentials: existing.map((row) => ({
        id: row.credentialId,
        transports: row.transports as never,
      })),
      authenticatorSelection: {
        // discoverable, so the credential can identify the user on its own —
        // this is what makes usernameless sign-in possible (OS-490)
        residentKey: 'required',
        // Face ID / Touch ID / PIN on every ceremony. This is what makes a
        // passkey two factors in one gesture rather than just possession.
        userVerification: 'required',
      },
    });

    await this.issueChallenge('registration', options.challenge, userId);
    return options;
  }

  async verifyRegistration(
    user: AuthenticatedUser,
    response: RegistrationResponseJSON,
    nickname: string | undefined,
  ): Promise<{
    passkey: PasskeyDto;
    access_token: string;
    recoveryCodes?: string[];
  }> {
    const challenge = await this.consumeChallenge(
      readChallengeFromResponse(response),
      'registration',
      user.sub,
    );

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: webauthnConfig.expectedOrigins,
        expectedRPID: webauthnConfig.rpID,
        requireUserVerification: true,
      });
    } catch {
      // the library throws on a malformed or mismatched response; a caller
      // shouldn't be able to tell those apart from a plain rejection
      throw new UnauthorizedException('Could not verify this passkey');
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException('Could not verify this passkey');
    }

    const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
      verification.registrationInfo;

    // Insert, decide whether this is a first factor, and issue the codes in
    // ONE locked transaction. Committing the credential first and counting
    // afterwards has two failure modes: a throw during issuance leaves a
    // registered passkey with no codes, and two concurrent first
    // registrations each count two credentials afterwards and each conclude
    // they weren't first — so the user ends up with two passkeys and no
    // recovery codes at all, silently.
    const { inserted, recoveryCodes } = await this.db.transaction(
      async (tx) => {
        await this.authService.lockUserFactors(tx, user.sub);

        let row: typeof userPasskeysTable.$inferSelect;
        try {
          [row] = await tx
            .insert(userPasskeysTable)
            .values({
              userId: user.sub,
              credentialId: credential.id,
              publicKey: isoBase64URL.fromBuffer(credential.publicKey),
              counter: credential.counter,
              transports: credential.transports ?? [],
              deviceType: credentialDeviceType,
              backedUp: credentialBackedUp,
              aaguid,
              nickname: nickname?.trim() || 'Passkey',
            })
            .returning();
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new ConflictException('This passkey is already registered');
          }
          throw err;
        }

        // Counted inside the transaction, so it sees the row just inserted
        // and nothing a concurrent registration has yet committed. A first
        // factor of *either* kind issues the one batch of recovery codes —
        // before passkeys this only happened in confirmMfa, which would have
        // left a passkey-only user with no recovery path at all.
        const { totpConfirmed, passkeyCount } =
          await this.authService.getFactorState(user.sub, tx);
        const isFirstFactor = !totpConfirmed && passkeyCount === 1;

        return {
          inserted: row,
          recoveryCodes: isFirstFactor
            ? await this.authService.issueRecoveryCodes(tx, user.sub)
            : null,
        };
      },
    );

    // Re-mint so a caller who was being gated isn't stuck behind a stale
    // claim for the rest of their token's 8h life — same reason confirmMfa
    // re-mints. Note mfaEnrollmentSatisfied is deliberately carried over
    // unchanged rather than forced true: a passkey doesn't satisfy an
    // account-wide MFA requirement until sign-in can challenge on it
    // (OS-489). Forcing it here would be the bypass OS-484 closed.
    const access_token = await this.authService.createAccessToken({
      ...claimsFromUser(user),
      hasMfaFactor: true,
    });

    return {
      passkey: toPasskeyDto(inserted),
      access_token,
      ...(recoveryCodes ? { recoveryCodes } : {}),
    };
  }

  // The passkey branch of the password-then-second-factor challenge. The
  // caller holds no access token yet — a signin()-issued challenge token is
  // the only thing standing in for "the password was already checked" — so
  // both halves resolve it through AuthService rather than re-implementing
  // the `typ` check, which is what stops an access token being presented
  // here as proof of a second factor.
  async getChallengeAuthenticationOptions(
    challengeToken: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const user =
      await this.authService.resolveMfaChallengeToken(challengeToken);

    const credentials = await this.db
      .select()
      .from(userPasskeysTable)
      .where(eq(userPasskeysTable.userId, user.id));
    if (credentials.length === 0) {
      throw new UnauthorizedException('Invalid or expired challenge');
    }

    const options = await generateAuthenticationOptions({
      rpID: webauthnConfig.rpID,
      userVerification: 'required',
      // scoped to this user's credentials, unlike the usernameless flow
      // (OS-490) which deliberately sends an empty list
      allowCredentials: credentials.map((row) => ({
        id: row.credentialId,
        transports: row.transports as never,
      })),
    });

    await this.issueChallenge('authentication', options.challenge, user.id);
    return options;
  }

  async verifyChallengeAssertion(
    challengeToken: string,
    response: AuthenticationResponseJSON,
  ): Promise<SignInSuccessResult> {
    const user =
      await this.authService.resolveMfaChallengeToken(challengeToken);

    const challenge = await this.consumeChallenge(
      readChallengeFromResponse(response),
      'authentication',
      user.id,
    );

    const [passkey] = await this.db
      .select()
      .from(userPasskeysTable)
      .where(eq(userPasskeysTable.credentialId, response.id));

    // The credential lookup is by credentialId, which is unique GLOBALLY —
    // without this check any valid passkey would satisfy any user's
    // challenge, which is the whole second factor.
    if (!passkey || passkey.userId !== user.id) {
      throw new UnauthorizedException('Invalid or expired challenge');
    }

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: webauthnConfig.expectedOrigins,
        expectedRPID: webauthnConfig.rpID,
        requireUserVerification: true,
        credential: {
          id: passkey.credentialId,
          publicKey: isoBase64URL.toBuffer(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports as never,
        },
      });
    } catch {
      throw new UnauthorizedException('Could not verify this passkey');
    }

    if (!verification.verified) {
      throw new UnauthorizedException('Could not verify this passkey');
    }

    // A counter that goes backwards means two authenticators are presenting
    // the same credential — i.e. one is a clone. Skipped when both sides are
    // 0, because most platform authenticators don't implement counters at
    // all and always report 0.
    const { newCounter } = verification.authenticationInfo;
    if (newCounter > 0 && newCounter <= passkey.counter) {
      throw new UnauthorizedException('Could not verify this passkey');
    }

    await this.db
      .update(userPasskeysTable)
      .set({
        counter: newCounter,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(userPasskeysTable.id, passkey.id));

    // Same terminus as verifyMfaChallenge: a factor the caller just proved
    // possession of always satisfies an account-wide requirement.
    return this.authService.buildSignInSuccess(user, {
      mfaEnrollmentSatisfied: true,
      hasMfaFactor: true,
    });
  }

  async rename(
    userId: number,
    passkeyId: number,
    nickname: string,
  ): Promise<PasskeyDto> {
    const [updated] = await this.db
      .update(userPasskeysTable)
      .set({ nickname: nickname.trim(), updatedAt: new Date() })
      // scoped by userId as well as id — the id alone is guessable
      .where(
        and(
          eq(userPasskeysTable.id, passkeyId),
          eq(userPasskeysTable.userId, userId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException('Passkey not found');
    return toPasskeyDto(updated);
  }

  // Requires current-password re-entry, the same bar as disabling TOTP: the
  // point of a second factor is that a password alone shouldn't be enough to
  // weaken an account.
  async remove(
    userId: number,
    accountId: number,
    passkeyId: number,
    password: string,
  ): Promise<void> {
    await this.authService.verifyPassword(userId, password);

    const [passkey] = await this.db
      .select()
      .from(userPasskeysTable)
      .where(
        and(
          eq(userPasskeysTable.id, passkeyId),
          eq(userPasskeysTable.userId, userId),
        ),
      );
    if (!passkey) throw new NotFoundException('Passkey not found');

    const [account] = await this.db
      .select({ requireMfaAt: accountsTable.requireMfaAt })
      .from(accountsTable)
      .where(eq(accountsTable.id, accountId));

    // Counting and deleting in one locked transaction. Apart, two concurrent
    // removals of different credentials each see two factors, each conclude
    // one will remain, and the user lands on zero — as does a removal racing
    // AuthService.disableMfa, which takes the same lock for that reason.
    await this.db.transaction(async (tx) => {
      await this.authService.lockUserFactors(tx, userId);

      if (account?.requireMfaAt) {
        const { totpConfirmed, passkeyCount } =
          await this.authService.getFactorState(userId, tx);
        const remaining = passkeyCount - 1 + (totpConfirmed ? 1 : 0);
        if (remaining === 0) {
          throw new ConflictException(
            'Your account requires MFA — this is your last factor, add another before removing it',
          );
        }
      }

      await tx
        .delete(userPasskeysTable)
        .where(eq(userPasskeysTable.id, passkey.id));
    });
  }

  private async issueChallenge(
    type: WebauthnChallengeType,
    challenge: string,
    userId: number | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // There is no cron in this repo, so expired rows are pruned by
      // whichever call issues the next challenge. Bounded and self-healing
      // as long as anyone ever signs in.
      await tx
        .delete(webauthnChallengesTable)
        .where(lt(webauthnChallengesTable.expiresAt, new Date()));

      await tx.insert(webauthnChallengesTable).values({
        challenge,
        type,
        userId,
        expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS),
      });
    });
  }

  // Single-use, enforced by the conditional UPDATE ... RETURNING idiom used
  // for recovery codes: two concurrent verifies of the same challenge both
  // pass any read, but Postgres serializes the UPDATEs, and the second
  // re-evaluates its WHERE against the committed row and matches nothing.
  // An empty returning() is therefore "already spent", not "not found".
  private async consumeChallenge(
    challenge: string,
    type: WebauthnChallengeType,
    userId: number | null,
  ): Promise<string> {
    const [row] = await this.db
      .update(webauthnChallengesTable)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(webauthnChallengesTable.challenge, challenge),
          eq(webauthnChallengesTable.type, type),
          isNull(webauthnChallengesTable.consumedAt),
          gt(webauthnChallengesTable.expiresAt, new Date()),
          ...(userId === null
            ? []
            : [eq(webauthnChallengesTable.userId, userId)]),
        ),
      )
      .returning();

    if (!row) throw new UnauthorizedException('Challenge expired — try again');
    return row.challenge;
  }
}

function toPasskeyDto(row: typeof userPasskeysTable.$inferSelect): PasskeyDto {
  // deliberately never the credential id or public key — the client has no
  // use for either, and they're the parts worth not handing out
  return {
    id: row.id,
    nickname: row.nickname,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

// The challenge the browser actually signed over, read back out of
// clientDataJSON. Using this rather than "the user's newest pending
// challenge" is what makes single-use meaningful when someone has two
// ceremonies open in two tabs.
function readChallengeFromResponse(response: {
  response: { clientDataJSON: string };
}): string {
  try {
    const clientData: unknown = JSON.parse(
      isoBase64URL.toUTF8String(response.response.clientDataJSON),
    );
    const challenge =
      typeof clientData === 'object' &&
      clientData !== null &&
      'challenge' in clientData
        ? clientData.challenge
        : undefined;
    if (typeof challenge !== 'string' || !challenge) {
      throw new Error('no challenge');
    }
    return challenge;
  } catch {
    throw new UnauthorizedException('Could not verify this passkey');
  }
}
