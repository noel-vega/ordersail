import { AsyncLocalStorage } from 'node:async_hooks';
import type { LoggerService } from '@nestjs/common';
import { pino, type Logger as PinoLogger } from 'pino';

// ---------------------------------------------------------------------------
// correlation context
// ---------------------------------------------------------------------------

type CorrelationStore = { correlationId: string };

const als = new AsyncLocalStorage<CorrelationStore>();

// wraps the rest of an HTTP request (APIs) or a single job's processing
// (worker) so every log line emitted anywhere in that call stack — including
// inside services several layers deep — picks up the same correlation ID
// without it having to be threaded through every function signature
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return als.run({ correlationId }, fn);
}

export function getCorrelationId(): string | undefined {
  return als.getStore()?.correlationId;
}

// ---------------------------------------------------------------------------
// root pino instance
// ---------------------------------------------------------------------------

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type ConfigureLoggingOptions = {
  service: string;
  nodeEnv: 'development' | 'test' | 'production';
  // falls back to info in production, debug elsewhere
  level?: LogLevel;
};

// stamps the ambient correlation ID onto every line; request-context fields
// (accountId, userId, …) join it here in OS-479
function mixin(): Record<string, unknown> {
  const correlationId = getCorrelationId();
  return correlationId ? { correlationId } : {};
}

// Before configureLogging() runs (specs, scripts, module-level code that logs
// during import) lines still go somewhere sensible: JSON at info, silent under
// jest so unmocked service logs don't flood test output.
let root: PinoLogger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
  mixin,
});

// Called once at the top of each service's main.ts, before NestFactory.create.
// Production writes one JSON object per line to stdout (ECS → CloudWatch);
// everywhere else pretty-prints through pino-pretty. Field contract:
// docs/observability.md.
export function configureLogging(options: ConfigureLoggingOptions): PinoLogger {
  const isProduction = options.nodeEnv === 'production';
  root = pino({
    level: options.level ?? (isProduction ? 'info' : 'debug'),
    base: { service: options.service, env: options.nodeEnv },
    mixin,
    ...(isProduction
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,service,env,context',
              messageFormat: '[{context}] {msg}',
            },
          },
        }),
  });
  return root;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

type Fields = Record<string, unknown>;

function isPlainObject(value: unknown): value is Fields {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    !Array.isArray(value)
  );
}

function looksLikeStack(value: string): boolean {
  return /\n\s+at /.test(value);
}

// Accepts both call styles so existing call sites and Nest's own framework
// logging keep working while OS-481 migrates services to the contract:
//
//   pino style:  logger.info({ event, orderId }, 'Order created')
//                logger.error({ err, orderId }, 'Label purchase failed')
//   Nest style:  logger.log('message', 'ContextName')
//                logger.error('message', err.stack, 'ContextName')
//                logger.error('message', err)
export function normalizeLogArgs(
  context: string | undefined,
  first: unknown,
  rest: unknown[],
): [Fields, string | undefined] {
  const fields: Fields = context ? { context } : {};

  if (isPlainObject(first)) {
    const msg = typeof rest[0] === 'string' ? rest[0] : undefined;
    return [{ ...fields, ...first }, msg];
  }
  if (first instanceof Error) {
    fields.err = first;
    return [fields, typeof rest[0] === 'string' ? rest[0] : first.message];
  }

  const msg = typeof first === 'string' ? first : String(first);
  const extras = [...rest];
  // Nest passes the context name as the trailing string argument
  const last = extras[extras.length - 1];
  if (typeof last === 'string' && !looksLikeStack(last)) {
    fields.context = extras.pop();
  }
  for (const extra of extras) {
    if (extra instanceof Error) fields.err = extra;
    else if (typeof extra === 'string' && looksLikeStack(extra)) fields.stack = extra;
    else if (extra !== undefined) fields.detail = extra;
  }
  return [fields, msg];
}

// Drop-in for Nest's Logger (`new Logger(X.name)`, no DI) that writes through
// the shared pino root. Also passed to NestFactory.create as the app logger so
// framework output (bootstrap, route mapping, unhandled exceptions) and
// `@nestjs/common` Logger instances land in the same stream.
export class Logger implements LoggerService {
  private readonly context?: string;

  constructor(context?: string) {
    this.context = context;
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  info(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  // Nest's name for info
  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  // Nest's name for the level below debug
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }

  private write(
    level: Exclude<LogLevel, 'silent'>,
    message: unknown,
    rest: unknown[],
  ): void {
    const [fields, msg] = normalizeLogArgs(this.context, message, rest);
    root[level](fields, msg);
  }
}
