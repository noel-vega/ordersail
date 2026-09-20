import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { type DbTransaction } from 'src/shared/database/database.types';
import {
  accountsTable,
  count,
  type db as Db,
  eq,
  userMfaTable,
  userPasskeysTable,
  usersTable,
} from 'db/identity';

// what second factors a user holds, across both factor tables
export interface FactorState {
  totpConfirmed: boolean;
  passkeyCount: number;
  hasMfaFactor: boolean;
}

// the factor-derived token claim — see getFactorClaims()
export interface FactorClaims {
  mfaEnrollmentSatisfied: boolean;
}

// The read side of a User's Factors: what they hold, whether one is required
// of them, and the one token claim that follows. Its own provider rather than
// part of AuthService because SessionsService recomputes that claim on
// every refresh, and AuthService in turn depends on SessionsService — reading
// it through AuthService would be a dependency cycle.
@Injectable()
export class FactorStateService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  // What second factors this user actually holds. A "factor" is a confirmed
  // TOTP row OR at least one passkey — the two live in different tables
  // (user_mfa is one-per-user, user_passkeys is many), so every "do they
  // have one" question goes through here rather than reading either table
  // directly.
  //
  // Returns the components and not just the boolean because callers need
  // different parts: the signin challenge branch cares specifically about
  // TOTP, /auth/me reports passkeyCount, and the claim computation only
  // wants hasMfaFactor.
  // Public because PasskeysService needs the same answer when deciding
  // whether removing a credential would leave the user with no factor.
  //
  // Takes an optional transaction so a caller that is *mutating* factors can
  // read the count inside its own transaction, behind the same lock. Reading
  // it outside is a time-of-check/time-of-use hole: two concurrent removals
  // each see two factors, each decide one will remain, and the user lands on
  // zero. See AuthService.lockUserFactors().
  async getFactorState(
    userId: number,
    tx?: DbTransaction,
  ): Promise<FactorState> {
    const executor = tx ?? this.db;
    const [[mfa], [passkeys]] = await Promise.all([
      executor
        .select({ confirmedAt: userMfaTable.confirmedAt })
        .from(userMfaTable)
        .where(eq(userMfaTable.userId, userId)),
      executor
        .select({ value: count() })
        .from(userPasskeysTable)
        .where(eq(userPasskeysTable.userId, userId)),
    ]);

    const totpConfirmed = mfa?.confirmedAt != null;
    const passkeyCount = passkeys?.value ?? 0;
    return {
      totpConfirmed,
      passkeyCount,
      hasMfaFactor: totpConfirmed || passkeyCount > 0,
    };
  }

  async getFactorClaims(userId: number): Promise<FactorClaims> {
    const factors = await this.getFactorState(userId);
    return this.toFactorClaims(userId, factors);
  }

  // Whether this user must hold a factor, and on whose say-so. Two sources,
  // either is enough: the account-wide policy an Owner switches on
  // (accounts.requireMfaAt, OS-473) and the per-user stamp an invited staff
  // member gets when they join (users.factorRequiredAt, OS-494). The one
  // place the rule lives — the enrollment claim and both last-factor checks
  // read it, so they can't drift apart. Returns which source applies only so
  // a refusal can say something true about how to lift it; 'account' wins
  // when both are set because that's the one an Owner can act on.
  async getFactorRequirement(
    userId: number,
    tx?: DbTransaction,
  ): Promise<'account' | 'user' | null> {
    const [row] = await (tx ?? this.db)
      .select({
        requireMfaAt: accountsTable.requireMfaAt,
        factorRequiredAt: usersTable.factorRequiredAt,
      })
      .from(usersTable)
      .innerJoin(accountsTable, eq(usersTable.accountId, accountsTable.id))
      .where(eq(usersTable.id, userId));

    if (row?.requireMfaAt) return 'account';
    if (row?.factorRequiredAt) return 'user';
    return null;
  }

  // The token claim that depends on factor state.
  //
  // mfaEnrollmentSatisfied: is anything *blocking* this user — a factor is
  // required of them (account-wide policy, or the stamp an invited staff
  // member carries — see getFactorRequirement) and they haven't enrolled.
  // Nothing requires it -> trivially satisfied, even with no factor.
  //
  // "Does the user hold any factor at all" is NOT a claim: the per-route
  // gate for money/access-sensitive actions (OS-492) reads it live from
  // getFactorState(), as does /auth/me.
  //
  // Holding a factor and satisfying a requirement are now the same
  // question, and were deliberately not always so: a factor satisfies an
  // account-wide MFA requirement exactly when
  // sign-in can make the user prove it. Between OS-484 and OS-489 enrollment
  // counted only a confirmed TOTP factor, because nothing could verify a
  // passkey yet — counting one would have left a require-MFA account
  // reachable with a password alone, the user holding a factor nobody ever
  // asked them to present. Keep them moving together if a third factor type
  // is ever added.
  async toFactorClaims(
    userId: number,
    factors: FactorState,
  ): Promise<FactorClaims> {
    const requirement = await this.getFactorRequirement(userId);

    return {
      mfaEnrollmentSatisfied: !requirement || factors.hasMfaFactor,
    };
  }
}
