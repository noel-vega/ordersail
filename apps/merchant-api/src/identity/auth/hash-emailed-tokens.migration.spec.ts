import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  eq,
  userEmailVerificationsTable,
  userInvitesTable,
  userPasswordResetsTable,
} from 'db/identity';
import { insertAccount, insertUser, useTestDb } from 'test-support';
import { hashToken } from 'src/shared/common/generate-token.util';

// Testcontainers applies every migration to an *empty* database, so a data
// migration's UPDATE never runs against real rows there. This spec seeds
// rows first and runs the OS-476 backfill SQL directly: if its digest ever
// drifts from hashToken(), every outstanding emailed link would silently die.
const db = useTestDb();

function backfillSql(): string {
  const drizzleDir = path.resolve(
    __dirname,
    '../../../../../packages/db/drizzle',
  );
  const dir = readdirSync(drizzleDir).find((d) =>
    d.endsWith('_hash_emailed_tokens'),
  );
  if (!dir) throw new Error('hash_emailed_tokens migration not found');
  return readFileSync(path.join(drizzleDir, dir, 'migration.sql'), 'utf8');
}

const tables = [
  { name: 'user_invites', table: userInvitesTable },
  { name: 'user_password_resets', table: userPasswordResetsTable },
  { name: 'user_email_verifications', table: userEmailVerificationsTable },
] as const;

describe('hash_emailed_tokens migration (OS-476)', () => {
  it.each(tables)(
    'hashes plaintext $name tokens to hashToken() and leaves digests alone, idempotently',
    async ({ table }) => {
      const account = await insertAccount(db);
      const legacyUser = await insertUser(db, { accountId: account.id });
      const hashedUser = await insertUser(db, { accountId: account.id });
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      // generateToken(32)-shaped: 43 chars of base64url
      const legacyRaw = 'Ab3_-xYz0123456789ABCDEFGHIJKLMNOPQRSTUVWxy';
      const alreadyHashed = hashToken('issued-after-deploy');
      await db.insert(table).values([
        { userId: legacyUser.id, token: legacyRaw, expiresAt },
        { userId: hashedUser.id, token: alreadyHashed, expiresAt },
      ]);

      await db.$client.query(backfillSql());

      const tokenFor = async (userId: number) =>
        (await db.select().from(table).where(eq(table.userId, userId)))[0]
          ?.token;

      expect(await tokenFor(legacyUser.id)).toBe(hashToken(legacyRaw));
      expect(await tokenFor(hashedUser.id)).toBe(alreadyHashed);

      await db.$client.query(backfillSql());
      expect(await tokenFor(legacyUser.id)).toBe(hashToken(legacyRaw));
      expect(await tokenFor(hashedUser.id)).toBe(alreadyHashed);
    },
  );
});
