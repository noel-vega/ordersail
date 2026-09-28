import { registerDecorator, type ValidationOptions } from 'class-validator';

// true for any IANA zone name the runtime's ICU data knows ("UTC",
// "America/New_York"); Intl throws a RangeError on anything else
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function IsTimeZone(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
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
}
