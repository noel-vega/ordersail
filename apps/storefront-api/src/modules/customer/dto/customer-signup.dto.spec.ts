import { createHash } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerSignUpDto } from './customer-signup.dto';

const validBase = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
};

function hibpSuffixFor(password: string): string {
  return createHash('sha1')
    .update(password)
    .digest('hex')
    .toUpperCase()
    .slice(5);
}

describe('CustomerSignUpDto password policy (OS-317)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('rejects a weak, guessable password without even checking HIBP', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const dto = plainToInstance(CustomerSignUpDto, {
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
      text: () => Promise.resolve(`${hibpSuffixFor(password)}:5`),
    });

    const dto = plainToInstance(CustomerSignUpDto, { ...validBase, password });
    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  it('accepts a strong password HIBP does not report as breached', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('UNRELATEDSUFFIX0000000000000000000:1'),
    });

    const dto = plainToInstance(CustomerSignUpDto, {
      ...validBase,
      password: 'Qr7#vNw4tKzL9pXs',
    });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });
});
