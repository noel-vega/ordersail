import { decryptMfaSecret, encryptMfaSecret } from './mfa-crypto';

describe('mfa-crypto', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const stored = encryptMfaSecret(secret);

    expect(stored).not.toContain(secret);
    expect(decryptMfaSecret(stored)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encryptMfaSecret(secret)).not.toBe(encryptMfaSecret(secret));
  });

  it('rejects a tampered ciphertext', () => {
    const stored = encryptMfaSecret('JBSWY3DPEHPK3PXP');
    const [iv, authTag, ciphertext] = stored.split(':');
    const tampered = `${iv}:${authTag}:${ciphertext.slice(0, -2)}00`;

    expect(() => decryptMfaSecret(tampered)).toThrow();
  });
});
