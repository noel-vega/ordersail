// `platform`'s view of the `stock` context: the one check PosDevicesService
// needs before placing a POS device at a location. The service depends on
// this interface, never on `stock`'s concrete service, so extracting `stock`
// changes only locations.adapter.ts. See ARCHITECTURE.md § Cross-context
// communication.

export const LOCATIONS_PORT = Symbol('PLATFORM_LOCATIONS_PORT');

export interface LocationsPort {
  // Resolves when the location belongs to the account; otherwise throws
  // BadRequestException('Location not found').
  assertAccountLocation(accountId: number, locationId: number): Promise<void>;
}
