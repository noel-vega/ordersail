import { BadRequestException } from '@nestjs/common';

// A dashboard reporting range: whole local calendar days in the account's
// timezone, both ends inclusive. Kept as YYYY-MM-DD dates on purpose — the
// conversion of each local midnight to a UTC instant happens in Postgres
// (`(date::timestamp AT TIME ZONE tz) AT TIME ZONE 'UTC'`), which has the real
// tz rules, so DST transitions come out right without offset math here.
export interface ReportingRange {
  from: string;
  to: string;
  // the equal-length window immediately before, for period comparison
  previousFrom: string;
  previousTo: string;
}

// relative ranges ending today in the account's zone, resolved here rather
// than in the browser: the client can't know the account's "today" without
// GET /account (account:read), which a dashboard:read role may lack (OS-193)
export const RANGE_PRESETS = ['today', '7d', '30d', '90d', '12m'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

// inclusive length in days, today included
const PRESET_DAYS: Record<RangePreset, number> = {
  today: 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '12m': 365,
};

export const DEFAULT_RANGE_DAYS = PRESET_DAYS['30d'];
// ~2 years — bounds the query cost and the timeseries point count
export const MAX_RANGE_DAYS = 731;

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// calendar-date arithmetic is timezone-free: a date is pinned to UTC midnight
// only so Date can add days to it
function parseDate(value: string, name: string): number {
  const ms = ISO_DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  // Date.parse rolls 2026-02-30 over to March — round-trip to reject it
  if (Number.isNaN(ms) || formatDate(ms) !== value) {
    throw new BadRequestException(`${name} must be a date as YYYY-MM-DD`);
  }
  return ms;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// the calendar date it currently is in `timezone`
export function todayIn(timezone: string, now: Date): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// `from`/`to` as sent by the client (either may be omitted): a missing `to`
// is today in the account's zone, a missing `from` makes the window `range`'s
// length (default 30 days) ending at `to`. So `?range=7d` alone is the last
// 7 days, and an explicit `from` wins over `range`.
export function resolveRange(input: {
  from?: string;
  to?: string;
  range?: RangePreset;
  timezone: string;
  now: Date;
}): ReportingRange {
  const to = parseDate(input.to ?? todayIn(input.timezone, input.now), 'to');
  const days = input.range ? PRESET_DAYS[input.range] : DEFAULT_RANGE_DAYS;
  const from =
    input.from !== undefined
      ? parseDate(input.from, 'from')
      : to - (days - 1) * DAY_MS;

  if (from > to) {
    throw new BadRequestException('from must be on or before to');
  }
  const span = (to - from) / DAY_MS + 1;
  if (span > MAX_RANGE_DAYS) {
    throw new BadRequestException(
      `range can span at most ${MAX_RANGE_DAYS} days`,
    );
  }

  const previousTo = from - DAY_MS;
  return {
    from: formatDate(from),
    to: formatDate(to),
    previousFrom: formatDate(previousTo - (span - 1) * DAY_MS),
    previousTo: formatDate(previousTo),
  };
}
