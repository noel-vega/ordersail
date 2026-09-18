import {
  eq,
  isUniqueViolation,
  userPasskeysTable,
  usersTable,
  webauthnChallengesTable,
} from 'db/identity';
import {
  insertAccount,
  insertUser,
  insertUserPasskey,
  insertWebauthnChallenge,
  useTestDb,
} from 'test-support';

// Schema-level invariants for OS-483. Each of these is invisible in normal
// use and only surfaces as a production auth failure, so they're pinned
// here rather than left to the column definitions.
const db = useTestDb();

async function seedUser(email: string) {
  const account = await insertAccount(db);
  return insertUser(db, { accountId: account.id, email });
}

describe('user_passkeys (OS-483)', () => {
  // Usernameless sign-in receives only the credential ID back from the
  // authenticator and resolves the user from it. Scoped per-user, two users
  // could hold the same ID and that lookup would be ambiguous.
  it('rejects the same credential id registered to a different user', async () => {
    const a = await seedUser('a@passkeys.test');
    const b = await seedUser('b@passkeys.test');
    await insertUserPasskey(db, { userId: a.id, credentialId: 'shared-cred' });

    const err = await insertUserPasskey(db, {
      userId: b.id,
      credentialId: 'shared-cred',
    }).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('allows one user many passkeys', async () => {
    const user = await seedUser('many@passkeys.test');
    await insertUserPasskey(db, { userId: user.id, nickname: 'Laptop' });
    await insertUserPasskey(db, { userId: user.id, nickname: 'Phone' });

    const rows = await db
      .select()
      .from(userPasskeysTable)
      .where(eq(userPasskeysTable.userId, user.id));
    expect(rows).toHaveLength(2);
  });

  // The column is bigint precisely for this. Signature counters are uint32,
  // and int4 tops out at 2147483647 — every sibling table in the schema
  // directory uses integer(), so "tidying" this one back would look like a
  // consistency fix and would start rejecting high-count authenticators.
  it('stores a signature counter above the int4 ceiling', async () => {
    const user = await seedUser('counter@passkeys.test');
    const maxUint32 = 4_294_967_295;
    const row = await insertUserPasskey(db, {
      userId: user.id,
      counter: maxUint32,
    });

    const [stored] = await db
      .select()
      .from(userPasskeysTable)
      .where(eq(userPasskeysTable.id, row.id));
    expect(stored?.counter).toBe(maxUint32);
  });

  it('cascades when the user is deleted', async () => {
    const user = await seedUser('cascade@passkeys.test');
    await insertUserPasskey(db, { userId: user.id });

    await db.delete(usersTable).where(eq(usersTable.id, user.id));

    expect(await db.select().from(userPasskeysTable)).toHaveLength(0);
  });
});

describe('users.webauthn_handle (OS-483)', () => {
  // Handed to the authenticator at registration and then kept in the user's
  // password manager for the life of the passkey — so it must exist without
  // anyone setting it, and must not be guessable from the user id.
  it('is populated automatically and differs per user', async () => {
    const a = await seedUser('handle-a@passkeys.test');
    const b = await seedUser('handle-b@passkeys.test');

    const rows = await db
      .select({ id: usersTable.id, handle: usersTable.webauthnHandle })
      .from(usersTable);
    const handles = rows.map((r) => r.handle);

    expect(handles.every((h) => typeof h === 'string' && h.length > 0)).toBe(
      true,
    );
    expect(new Set(handles).size).toBe(2);
    expect(handles).not.toContain(String(a.id));
    expect(handles).not.toContain(String(b.id));
  });

  // The random default makes a collision implausible, but InsertUserSchema
  // lets a caller pass a handle explicitly — so the constraint is what
  // actually forbids two accounts presenting one WebAuthn identity.
  it('rejects two users sharing a handle', async () => {
    const account = await insertAccount(db);
    await insertUser(db, {
      accountId: account.id,
      email: 'dupe-a@passkeys.test',
      webauthnHandle: 'shared-handle',
    });

    const err = await insertUser(db, {
      accountId: account.id,
      email: 'dupe-b@passkeys.test',
      webauthnHandle: 'shared-handle',
    }).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });
});

describe('webauthn_challenges (OS-483)', () => {
  // Usernameless sign-in issues a challenge before anyone is identified.
  it('allows a null userId for the usernameless ceremony', async () => {
    const row = await insertWebauthnChallenge(db, {
      type: 'authentication',
      userId: null,
    });
    expect(row.userId).toBeNull();
  });

  // The challenge is the lookup key on consume, so a collision would let one
  // ceremony's response redeem another's row.
  it('rejects a duplicate challenge value', async () => {
    await insertWebauthnChallenge(db, {
      type: 'registration',
      challenge: 'dupe',
    });

    const err = await insertWebauthnChallenge(db, {
      type: 'registration',
      challenge: 'dupe',
    }).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('cascades when the user is deleted', async () => {
    const user = await seedUser('challenge-cascade@passkeys.test');
    await insertWebauthnChallenge(db, {
      type: 'registration',
      userId: user.id,
    });

    await db.delete(usersTable).where(eq(usersTable.id, user.id));

    expect(await db.select().from(webauthnChallengesTable)).toHaveLength(0);
  });
});
