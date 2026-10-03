// `catalog`'s view of the `stock` context: the one check ProductsService
// needs before placing a variant's opening stock at a location. The service
// depends on this interface, never on `stock`'s concrete service, so
// extracting `stock` changes only locations.adapter.ts. See ARCHITECTURE.md
// § Cross-context communication.

export const LOCATIONS_PORT = Symbol('CATALOG_LOCATIONS_PORT');

export interface LocationsPort {
  // Resolves when the location belongs to the account; otherwise throws
  // BadRequestException('Location not found').
  assertAccountLocation(accountId: number, locationId: number): Promise<void>;
}
