import { BadRequestException } from '@nestjs/common';
import type { SelectLocation } from 'db/stock';

// a location a label can be bought from: it has the street address a carrier
// picks up at and the phone it reaches there. Every other address field is
// optional to Shippo.
export type ShipFromLocation = SelectLocation & {
  addressLine1: string;
  phone: string;
};

// the location as a ship-from origin, or a 400 saying what it's missing.
// Both are checked here rather than left to Shippo, whose rejection (USPS
// won't quote without an origin phone) comes back as an opaque rate failure.
export function toShipFrom(
  location: SelectLocation | undefined,
): ShipFromLocation {
  if (!location?.addressLine1) {
    throw new BadRequestException(
      'That location has no shipping address on file',
    );
  }
  const { addressLine1, phone } = location;
  if (!phone) {
    throw new BadRequestException(
      `Add a phone number to ${location.name} before shipping from it`,
    );
  }
  return { ...location, addressLine1, phone };
}
