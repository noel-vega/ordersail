import z from "zod";
import type { Location } from "merchant-sdk";
import { formatPhone, optionalPhoneSchema } from "../../lib/phone";

// The fields that make a location a ship-from origin, shared by the create
// form and the edit sheet (mirrors merchant-api's ShipFromDto). All optional —
// a stock-only location needs none — but a label can't be bought from a
// location until it has an address and a phone (OS-688).
export const shipFromFormSchema = z.object({
  addressLine1: z.string(),
  addressLine2: z.string(),
  addressCity: z.string(),
  addressState: z.string(),
  addressPostalCode: z.string(),
  addressCountry: z.string(),
  // the contact carriers reach at this origin; a blank box clears it
  phone: optionalPhoneSchema,
});

export type ShipFromFormInput = z.input<typeof shipFromFormSchema>;
type ShipFromFormOutput = z.output<typeof shipFromFormSchema>;

// form values for a location's current ship-from details, or blank ones
export function shipFromDefaults(location?: Location): ShipFromFormInput {
  return {
    addressLine1: location?.addressLine1 ?? "",
    addressLine2: location?.addressLine2 ?? "",
    addressCity: location?.addressCity ?? "",
    addressState: location?.addressState ?? "",
    addressPostalCode: location?.addressPostalCode ?? "",
    addressCountry: location?.addressCountry ?? "",
    // stored as E.164; shown the way the merchant would type it
    phone: location?.phone ? formatPhone(location.phone) : "",
  };
}

// the request body: a blank box is null, which clears the field
export function toShipFromBody(data: ShipFromFormOutput) {
  return {
    addressLine1: data.addressLine1.trim() || null,
    addressLine2: data.addressLine2.trim() || null,
    addressCity: data.addressCity.trim() || null,
    addressState: data.addressState.trim() || null,
    addressPostalCode: data.addressPostalCode.trim() || null,
    addressCountry: data.addressCountry.trim() || null,
    // already E.164, or null for a blank box
    phone: data.phone,
  };
}
