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

export const DEFAULT_RANGE_DAYS = 30;
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
// is today in the account's zone, a missing `from` makes the window
// DEFAULT_RANGE_DAYS long ending at `to`
export function resolveRange(input: {
  from?: string;
  to?: string;
  timezone: string;
  now: Date;
}): ReportingRange {
  const to = parseDate(input.to ?? todayIn(input.timezone, input.now), 'to');
  const from =
    input.from !== undefined
      ? parseDate(input.from, 'from')
      : to - (DEFAULT_RANGE_DAYS - 1) * DAY_MS;

  if (from > to) {
    throw new BadRequestException('from must be on or before to');
  }
  const days = (to - from) / DAY_MS + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestException(
      `range can span at most ${MAX_RANGE_DAYS} days`,
    );
  }

  const previousTo = from - DAY_MS;
  return {
    from: formatDate(from),
    to: formatDate(to),
    previousFrom: formatDate(previousTo - (days - 1) * DAY_MS),
    previousTo: formatDate(previousTo),
  };
}
