import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended nonce size for GCM

function getKey(): Buffer {
  return Buffer.from(env.MFA_ENCRYPTION_KEY, 'hex');
}

// TOTP secrets are long-lived credentials (unlike a password, there's no
// hash-and-compare option — the raw secret is needed to verify a code), so
// they're encrypted at rest rather than stored plaintext. Stored as
// "iv:authTag:ciphertext", all hex.
export function encryptMfaSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptMfaSecret(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  const decipher = createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
