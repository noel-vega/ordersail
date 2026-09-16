import { createHash } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignUpDto } from './signup.dto';

const validBase = {
  businessName: 'Cactus Coffee',
  firstName: 'Dana',
  lastName: 'Scully',
  email: 'dana@cactus.test',
  phone: '5555550100',
};

function hibpSuffixFor(password: string): string {
  return createHash('sha1')
    .update(password)
    .digest('hex')
    .toUpperCase()
    .slice(5);
}

describe('SignUpDto password policy (OS-317)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('rejects a weak, guessable password without even checking HIBP', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const dto = plainToInstance(SignUpDto, {
      ...validBase,
      password: 'password123',
    });
    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'password')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a strong-looking password that HIBP reports as breached', async () => {
    const password = 'Xk9$mQz2vLpR7nTw';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          `${hibpSuffixFor(password)}:5\r\nUNRELATEDSUFFIX0000000000000000000:1`,
        ),
    });

    const dto = plainToInstance(SignUpDto, { ...validBase, password });
    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  it('accepts a strong password HIBP does not report as breached', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('UNRELATEDSUFFIX0000000000000000000:1'),
    });

    const dto = plainToInstance(SignUpDto, {
      ...validBase,
      password: 'Qr7#vNw4tKzL9pXs',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('fails open (accepts) when the HIBP check errors out', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    const dto = plainToInstance(SignUpDto, {
      ...validBase,
      password: 'Qr7#vNw4tKzL9pXs',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects a password shorter than 12 characters even if otherwise strong', async () => {
    const dto = plainToInstance(SignUpDto, {
      ...validBase,
      password: 'Xk9$mQz2',
    });
    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });
});
