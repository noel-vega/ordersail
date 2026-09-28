import { canonicalTimeZone, isValidTimeZone } from './is-time-zone';

describe('isValidTimeZone (OS-667)', () => {
  it.each(['UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata'])(
    'accepts %s',
    (tz) => expect(isValidTimeZone(tz)).toBe(true),
  );

  it.each(['', 'Mars/Olympus', 'EST5EDT/Nope', 'not a zone'])(
    'rejects %p',
    (tz) => expect(isValidTimeZone(tz)).toBe(false),
  );

  // Intl accepts these, but Postgres AT TIME ZONE would flip their sign
  it.each(['+05:00', '-03:00', '-0300'])('rejects the UTC offset %p', (tz) =>
    expect(isValidTimeZone(tz)).toBe(false),
  );

  it('rejects non-strings', () => {
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe('canonicalTimeZone (OS-667)', () => {
  it.each([
    ['utc', 'UTC'],
    ['Etc/UTC', 'UTC'],
    ['america/new_york', 'America/New_York'],
    ['US/Eastern', 'America/New_York'],
    ['America/Chicago', 'America/Chicago'],
  ])('%s -> %s', (input, canonical) =>
    expect(canonicalTimeZone(input)).toBe(canonical),
  );

  it('is null for an unknown zone or an offset', () => {
    expect(canonicalTimeZone('Mars/Olympus')).toBeNull();
    expect(canonicalTimeZone('+05:00')).toBeNull();
  });
});
