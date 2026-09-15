import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    '[db] DATABASE_URL is not set — copy packages/db/.env.example to .env',
  );
  process.exit(1);
}

export const db = drizzle(DATABASE_URL);

export { eq, ne, and, or, gt, inArray, notInArray, isNull, isNotNull, ilike, exists, sql, asc, desc } from 'drizzle-orm';
export type { SQL } from 'drizzle-orm';

export * from './schema/index.js';
export * from './permissions-catalog.js';
export * from './postgres-errors.js';

