import 'dotenv/config';
import { Logger } from 'logging';
import { z } from 'zod';

// re-export so every service pins the same zod through this package
export { z };

/**
 * Parse `process.env` against `schema` at boot. On failure, log one fatal
 * `app.boot_failed` line naming the offending vars (never their values) and
 * exit 1 — before the caller binds a port or opens a pool.
 *
 * This runs on import, ahead of `installProcessHandlers()` and
 * `configureLogging()`, so it can't rely on either: it logs through the
 * pre-configure root logger (JSON on synchronous stdout) and exits itself.
 *
 * `dotenv/config` is loaded on import (reads `<cwd>/.env`; under npm / nx the
 * cwd is the service's own directory).
 */
export function parseEnv<T extends z.ZodType>(service: string, schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    const err = new Error(
      `invalid environment: ${issues.map((issue) => `${issue.path} (${issue.message})`).join(', ')}`,
    );
    new Logger('Config').fatal(
      { err, event: 'app.boot_failed', service, issues },
      `[${service}] invalid environment`,
    );
    process.exit(1);
  }
  return result.data;
}
