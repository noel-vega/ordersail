import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { isE164Phone, IsE164Phone, toE164 } from './is-e164-phone';

describe('isE164Phone (OS-687)', () => {
  it.each(['+12015550123', '+442071838750', '+1 (201) 555-0123'])(
    'accepts %s',
    (phone) => expect(isE164Phone(phone)).toBe(true),
  );

  it.each([
    '',
    'asdf',
    // national format — the client must send "+…"
    '2015550123',
    '(201) 555-0123',
    // right shape, but not an assignable number
    '+15555550100',
    '+1201555012',
    // valid, but E.164 can't carry the extension
    '+1 201-555-0123 ext. 4421',
  ])('rejects %p', (phone) => expect(isE164Phone(phone)).toBe(false));

  it('rejects non-strings', () => {
    expect(isE164Phone(undefined)).toBe(false);
    expect(isE164Phone(12015550123)).toBe(false);
  });
});

describe('toE164 (OS-687)', () => {
  it.each([
    ['+12015550123', '+12015550123'],
    ['+1 (201) 555-0123', '+12015550123'],
    ['  +1 201-555-0123 ', '+12015550123'],
    ['+44 20 7183 8750', '+442071838750'],
  ])('%p -> %s', (input, e164) => expect(toE164(input)).toBe(e164));
});

describe('@IsE164Phone (OS-687)', () => {
  class Dto {
    @IsE164Phone()
    phone!: string;
  }

  it('stores the E.164 spelling', async () => {
    const dto = plainToInstance(Dto, { phone: '+1 (201) 555-0123' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.phone).toBe('+12015550123');
  });

  it('leaves an invalid value as sent and reports it', async () => {
    const dto = plainToInstance(Dto, { phone: 'asdf' });
    const errors = await validate(dto);
    expect(dto.phone).toBe('asdf');
    expect(errors.map((e) => e.property)).toEqual(['phone']);
  });
});
