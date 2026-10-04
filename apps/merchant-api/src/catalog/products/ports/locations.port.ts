// `catalog`'s view of the `stock` context: where a new variant's opening
// stock goes. The whole rule — ownership, the only location, refusing to guess
// among several — lives in `stock`, which owns locations. The service
// depends on this interface, never on `stock`'s concrete service, so
// extracting `stock` changes only locations.adapter.ts. See ARCHITECTURE.md
// § Cross-context communication.

export const LOCATIONS_PORT = Symbol('CATALOG_LOCATIONS_PORT');

export interface LocationsPort {
  // The location to hold `stock` units of opening stock, or null for no
  // inventory row (stock 0 with no single location to put it at). Throws
  // BadRequestException for a foreign locationId, or stock > 0 with no
  // location or several to choose from. See
  // LocationsService.resolveOpeningStockLocation.
  resolveOpeningStockLocation(
    accountId: number,
    stock: number,
    locationId: number | undefined,
  ): Promise<number | null>;
}
