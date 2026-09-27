// @ts-check
// Lint half of the log-line contract in docs/observability.md: fields go in
// the object, `msg` is a fixed string, errors go in `err`. Shared by every
// app's eslint.config.mjs so the rule changes in one place.
//
// Matches calls on `this.logger`, a bare `logger` and the static Nest
// `Logger`, and only the level methods, so `logger.child(...)` is left alone.
// Only direct arguments are checked: a computed value inside the fields
// object is fine.

const LOG_CALL =
  "CallExpression[callee.property.name=/^(fatal|error|warn|info|debug|trace|log|verbose)$/]" +
  ":matches([callee.object.property.name='logger'], [callee.object.name=/^(logger|Logger)$/])";

const HINT = "logger.info({ event, orderId }, 'Short message') — see docs/observability.md";

// no-restricted-syntax entries: `'no-restricted-syntax': ['error', ...logCallSelectors]`
export const logCallSelectors = [
  {
    selector: `${LOG_CALL} > TemplateLiteral.arguments[expressions.length>0]`,
    message: `Log fields, not interpolated strings: ${HINT}`,
  },
  {
    selector: `${LOG_CALL} > BinaryExpression.arguments[operator='+']`,
    message: `Log fields, not concatenated strings: ${HINT}`,
  },
  {
    selector: `${LOG_CALL} > MemberExpression.arguments[property.name=/^(message|stack)$/]`,
    message:
      "Pass the Error as `err`, not its message or stack: logger.error({ err, event }, 'Short message') — see docs/observability.md",
  },
];
