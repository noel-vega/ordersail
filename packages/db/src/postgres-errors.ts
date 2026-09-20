const POSTGRES_UNIQUE_VIOLATION = '23505';
const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';

// node-postgres errors carry `.code`, but drizzle-orm wraps them in a
// DrizzleQueryError, so the pg error ends up at `.cause` instead
function pgError(err: unknown): object | undefined {
  const inner =
    typeof err === 'object' && err !== null && 'cause' in err ? err.cause : err;
  return typeof inner === 'object' && inner !== null ? inner : undefined;
}

function pgErrorCode(err: unknown): string | undefined {
  const inner = pgError(err);
  return inner && 'code' in inner ? String(inner.code) : undefined;
}

// With `constraint`, true only for a violation of that one constraint — the
// name Postgres reports, e.g. `users_email_key`. Pass it wherever the error
// is translated into something a person reads ("Email already in use") and
// the guarded code writes more than one unique column: without it, any
// unique violation in there is reported as that one.
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (pgErrorCode(err) !== POSTGRES_UNIQUE_VIOLATION) return false;
  if (constraint === undefined) return true;
  const inner = pgError(err);
  return !!inner && 'constraint' in inner && inner.constraint === constraint;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorCode(err) === POSTGRES_FOREIGN_KEY_VIOLATION;
}
