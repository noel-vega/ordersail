import { Transform } from 'class-transformer';
import { registerDecorator, type ValidationOptions } from 'class-validator';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

// the E.164 form ("+12015550123") of an international phone number, or null
// when it isn't a valid one. No default region: only our own client sends
// these, and it parses the merchant's local-format input into "+…" before
// the request, so a bare national number here is a client bug, not a US
// number to guess at (OS-687)
export function toE164(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('+')) return null;
  const phone = parsePhoneNumberFromString(trimmed);
  // E.164 has no extension; accepting "… ext. 12" and storing it without
  // the extension would silently drop part of what was typed
  if (!phone?.isValid() || phone.ext) return null;
  return phone.number;
}

export function isE164Phone(value: unknown): value is string {
  return toE164(value) !== null;
}

// validates an international phone number and, under the transforming
// ValidationPipe, stores its E.164 spelling — so "+1 (201) 555-0123" and
// "+12015550123" land as the same value, and a carrier gets a number it
// accepts rather than whatever was typed
export function IsE164Phone(options?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    Transform(({ value }: { value: unknown }) => toE164(value) ?? value)(
      target,
      propertyName,
    );
    registerDecorator({
      name: 'isE164Phone',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a valid international phone number (e.g. +12015550123)`,
        ...options,
      },
      validator: { validate: isE164Phone },
    });
  };
}
