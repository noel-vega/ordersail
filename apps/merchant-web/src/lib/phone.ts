import { parsePhoneNumberFromString } from "libphonenumber-js";
import z from "zod";

// Merchants type numbers the way they're used to seeing them — "(201)
// 555-0123" — so a number with no "+" is read as a US one. merchant-api only
// accepts E.164 and has no default region (OS-687), so the schemas below emit
// E.164: a form's submitted values are already what the API takes.
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

function e164OrIssue(value: string, ctx: z.RefinementCtx): string {
  const e164 = toE164(value);
  if (e164 === null) {
    ctx.addIssue({ code: "custom", message: INVALID });
    return z.NEVER;
  }
  return e164;
}

// input is what was typed, output is its E.164 form
export const phoneSchema = z
  .string()
  .trim()
  .min(1, "Required")
  .transform(e164OrIssue);

// for fields where a blank box means "no number": outputs null for blank
export const optionalPhoneSchema = z
  .string()
  .transform((value, ctx) =>
    value.trim() === "" ? null : e164OrIssue(value, ctx),
  );

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
