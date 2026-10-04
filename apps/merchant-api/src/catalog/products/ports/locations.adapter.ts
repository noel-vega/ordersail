import { Injectable } from '@nestjs/common';
import { LocationsService } from 'src/stock';
import type { LocationsPort } from './locations.port';

// The only place in `catalog` that talks to the `stock` context's concrete
// service. In-process today; an HTTP client the day `stock` becomes its own
// service.
@Injectable()
export class LocationsAdapter implements LocationsPort {
  constructor(private readonly locations: LocationsService) {}

  resolveOpeningStockLocation(
    accountId: number,
    stock: number,
    locationId: number | undefined,
  ): Promise<number | null> {
    return this.locations.resolveOpeningStockLocation(
      accountId,
      stock,
      locationId,
    );
  }
}
