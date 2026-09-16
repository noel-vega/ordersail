import { randomInt } from 'node:crypto';

const RECOVERY_CODE_COUNT = 10;
// no ambiguous characters (0/O, 1/I/L) — these get read off a screen or a
// piece of paper and typed back in by hand
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

function generateOne(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

// plaintext codes, shown to the caller exactly once — never stored as-is,
// see AuthService.issueRecoveryCodes for the bcrypt-hash-before-persist step
export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
): string[] {
  return Array.from({ length: count }, generateOne);
}
