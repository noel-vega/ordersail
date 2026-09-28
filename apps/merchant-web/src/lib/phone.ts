import { parsePhoneNumberFromString } from "libphonenumber-js";
import z from "zod";

// Merchants type numbers the way they're used to seeing them — "(201)
// 555-0123" — so a number with no "+" is read as a US one. merchant-api only
// accepts E.164 and has no default region (OS-687), which is why every form
// converts through toE164 before it submits.
const DEFAULT_REGION = "US";

// the E.164 form ("+12015550123") of what was typed, or null when it isn't a
// valid number. An extension is rejected rather than dropped: E.164 can't
// hold one, and storing the number without it would lose part of the input.
export function toE164(input: string): string | null {
  const phone = parsePhoneNumberFromString(input.trim(), DEFAULT_REGION);
  if (!phone?.isValid() || phone.ext) return null;
  return phone.number;
}

const INVALID = "Enter a valid phone number";

export const phoneSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .refine((value) => toE164(value) !== null, INVALID);

// for fields where a blank box means "no number"
export const optionalPhoneSchema = z
  .string()
  .refine((value) => value.trim() === "" || toE164(value) !== null, INVALID);

// a stored number for display: national format for North American numbers,
// which is what a US merchant expects to read, international for the rest.
// Anything that doesn't parse (legacy free-form data) is shown as stored.
export function formatPhone(stored: string): string {
  const phone = parsePhoneNumberFromString(stored);
  if (!phone) return stored;
  return phone.countryCallingCode === "1"
    ? phone.formatNational()
    : phone.formatInternational();
}
