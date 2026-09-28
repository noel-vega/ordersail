import { isValidTimeZone } from './is-time-zone';

describe('isValidTimeZone (OS-667)', () => {
  it.each(['UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata'])(
    'accepts %s',
    (tz) => expect(isValidTimeZone(tz)).toBe(true),
  );

  it.each(['', 'Mars/Olympus', 'EST5EDT/Nope', 'not a zone'])(
    'rejects %p',
    (tz) => expect(isValidTimeZone(tz)).toBe(false),
  );

  it('rejects non-strings', () => {
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
