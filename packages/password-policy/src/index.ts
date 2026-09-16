import { createHash } from "node:crypto";
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from "class-validator";
import zxcvbn from "zxcvbn";

// zxcvbn scores 0 (trivially guessable) – 4 (very unguessable). 3 is the
// common floor for "acceptable" account passwords — not an arbitrary
// complexity rule (no forced digit/symbol), just "not obviously weak".
const MIN_ZXCVBN_SCORE = 3;
const HIBP_TIMEOUT_MS = 3000;

export interface PasswordCheckResult {
  ok: boolean;
  reason?: string;
}

// Have I Been Pwned's k-anonymity range API: only the first 5 hex characters
// of the SHA-1 hash are sent over the network. HIBP returns every suffix
// sharing that prefix (with breach counts); the match is done locally, so
// neither the password nor its full hash ever leaves this process.
//
// Fails open (treats an outage/timeout as "not breached") rather than
// blocking every signup/password-change on a third-party dependency being
// briefly unreachable — the zxcvbn strength floor still applies regardless.
async function isBreached(password: string): Promise<boolean> {
  const sha1 = createHash("sha1")
    .update(password)
    .digest("hex")
    .toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split("\r\n").some((line) => line.startsWith(suffix));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// `userInputs` feeds zxcvbn context (email, name, business name, ...) so a
// password built from those scores appropriately low, per its own docs.
export async function checkPasswordStrength(
  password: string,
  userInputs: string[] = [],
): Promise<PasswordCheckResult> {
  const { score } = zxcvbn(password, userInputs);
  if (score < MIN_ZXCVBN_SCORE) {
    return {
      ok: false,
      reason:
        "This password is too weak — try a longer passphrase or add another word.",
    };
  }

  if (await isBreached(password)) {
    return {
      ok: false,
      reason:
        "This password has appeared in a known data breach — please choose a different one.",
    };
  }

  return { ok: true };
}

const GENERIC_MESSAGE =
  "This password is too weak or has appeared in a known data breach — please choose a different one.";

// A class-validator custom decorator, async (class-validator's `validate()`
// is promise-aware, and NestJS's global ValidationPipe awaits it). The
// error message is deliberately the same regardless of which check failed
// — "too weak" vs "breached" isn't information a caller needs, and folding
// them into one message keeps this from becoming a second, subtler
// enumeration surface (see requestPasswordReset for the same reasoning
// applied to account existence).
//
// `userInputsFields` names sibling DTO properties (e.g. ['email',
// 'firstName', 'businessName']) to feed zxcvbn as context.
export function IsStrongPassword(
  userInputsFields: string[] = [],
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isStrongPassword",
      target: object.constructor,
      propertyName,
      options: { message: GENERIC_MESSAGE, ...validationOptions },
      validator: {
        async validate(value: unknown, args: ValidationArguments) {
          if (typeof value !== "string") return false;
          const source = args.object as Record<string, unknown>;
          const userInputs = userInputsFields
            .map((field) => source[field])
            .filter((v): v is string => typeof v === "string");
          const result = await checkPasswordStrength(value, userInputs);
          return result.ok;
        },
      },
    });
  };
}
