import { BadRequestException } from '@nestjs/common';
import { MAX_RANGE_DAYS, resolveRange, todayIn } from './range';

// 2026-09-28 03:00 UTC — still the 27th in New York, already the 28th in UTC
const now = new Date('2026-09-28T03:00:00Z');

describe('todayIn (OS-669)', () => {
  it('is the calendar date in the given zone', () => {
    expect(todayIn('UTC', now)).toBe('2026-09-28');
    expect(todayIn('America/New_York', now)).toBe('2026-09-27');
    expect(todayIn('Asia/Tokyo', now)).toBe('2026-09-28');
  });
});

describe('resolveRange (OS-669)', () => {
  it('defaults to the last 30 days ending today in the account zone', () => {
    expect(resolveRange({ timezone: 'America/New_York', now })).toEqual({
      from: '2026-08-29',
      to: '2026-09-27',
      previousFrom: '2026-07-30',
      previousTo: '2026-08-28',
    });
  });

  it('takes an explicit range and mirrors it for the previous period', () => {
    expect(
      resolveRange({
        from: '2026-09-01',
        to: '2026-09-07',
        timezone: 'UTC',
        now,
      }),
    ).toEqual({
      from: '2026-09-01',
      to: '2026-09-07',
      previousFrom: '2026-08-25',
      previousTo: '2026-08-31',
    });
  });

  it('a single day compares to the day before', () => {
    expect(
      resolveRange({
        from: '2026-03-01',
        to: '2026-03-01',
        timezone: 'UTC',
        now,
      }),
    ).toMatchObject({ previousFrom: '2026-02-28', previousTo: '2026-02-28' });
  });

  it('counts days across a DST change as calendar days', () => {
    // DST ends 2026-11-01 in New York — still 7 days, not 7×24h
    expect(
      resolveRange({
        from: '2026-10-29',
        to: '2026-11-04',
        timezone: 'America/New_York',
        now,
      }),
    ).toMatchObject({ previousFrom: '2026-10-22', previousTo: '2026-10-28' });
  });

  it('only `to` → the 30 days ending then; only `from` → through today', () => {
    expect(
      resolveRange({ to: '2026-06-30', timezone: 'UTC', now }),
    ).toMatchObject({ from: '2026-06-01', to: '2026-06-30' });
    expect(
      resolveRange({ from: '2026-09-20', timezone: 'UTC', now }),
    ).toMatchObject({ from: '2026-09-20', to: '2026-09-28' });
  });

  it.each([
    [{ from: '2026-9-1', to: '2026-09-07' }, 'from must be a date'],
    [{ from: '2026-02-30', to: '2026-03-07' }, 'from must be a date'],
    [{ from: '2026-09-01', to: 'yesterday' }, 'to must be a date'],
    [{ from: '2026-09-08', to: '2026-09-07' }, 'on or before'],
  ])('rejects %p', (range, message) => {
    expect(() => resolveRange({ ...range, timezone: 'UTC', now })).toThrow(
      new RegExp(message),
    );
    expect(() => resolveRange({ ...range, timezone: 'UTC', now })).toThrow(
      BadRequestException,
    );
  });

  it(`allows ${MAX_RANGE_DAYS} days and rejects one more`, () => {
    expect(() =>
      resolveRange({
        from: '2024-09-28',
        to: '2026-09-28',
        timezone: 'UTC',
        now,
      }),
    ).not.toThrow(); // 730 days apart = 731 inclusive
    expect(() =>
      resolveRange({
        from: '2024-09-27',
        to: '2026-09-28',
        timezone: 'UTC',
        now,
      }),
    ).toThrow(/at most/);
  });
});

describe('resolveRange presets (OS-193)', () => {
  // today in New York is 2026-09-27 at `now`
  it.each([
    ['today', '2026-09-27', '2026-09-26', '2026-09-26'],
    ['7d', '2026-09-21', '2026-09-14', '2026-09-20'],
    ['30d', '2026-08-29', '2026-07-30', '2026-08-28'],
    ['90d', '2026-06-30', '2026-04-01', '2026-06-29'],
    ['12m', '2025-09-28', '2024-09-28', '2025-09-27'],
  ] as const)(
    '%s ends today in the account zone',
    (range, from, previousFrom, previousTo) => {
      expect(
        resolveRange({ range, timezone: 'America/New_York', now }),
      ).toEqual({ from, to: '2026-09-27', previousFrom, previousTo });
    },
  );

  it('an explicit from wins over range', () => {
    expect(
      resolveRange({
        range: '7d',
        from: '2026-09-01',
        to: '2026-09-15',
        timezone: 'UTC',
        now,
      }),
    ).toMatchObject({ from: '2026-09-01', to: '2026-09-15' });
  });

  it('range with an explicit to ends there', () => {
    expect(
      resolveRange({ range: '7d', to: '2026-06-30', timezone: 'UTC', now }),
    ).toMatchObject({ from: '2026-06-24', to: '2026-06-30' });
  });
});
