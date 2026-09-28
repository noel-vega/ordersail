import { Transform } from 'class-transformer';
import { registerDecorator, type ValidationOptions } from 'class-validator';

// the runtime ICU's canonical name for a zone ("utc" -> "UTC", "US/Eastern"
// -> "America/New_York"), or null when it isn't a named zone. Intl also
// accepts bare UTC offsets ("+05:00"); those are rejected, because Postgres
// reads an offset in AT TIME ZONE with the POSIX sign, i.e. flipped
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let zone: string;
  try {
    zone = new Intl.DateTimeFormat('en-US', {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return /^[+-]/.test(zone) ? null : zone;
}

export function isValidTimeZone(value: unknown): value is string {
  return canonicalTimeZone(value) !== null;
}

// validates an IANA zone name and, under the transforming ValidationPipe,
// stores its canonical spelling. Canonical follows this runtime's ICU, which
// may be the legacy link ("Asia/Calcutta" for "Asia/Kolkata"); Postgres knows
// both, so normalise rather than 400 a zone a newer browser reports
export function IsTimeZone(options?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    Transform(
      ({ value }: { value: unknown }) => canonicalTimeZone(value) ?? value,
    )(target, propertyName);
    registerDecorator({
      name: 'isTimeZone',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be an IANA time zone name`,
        ...options,
      },
      validator: { validate: isValidTimeZone },
    });
  };
}
