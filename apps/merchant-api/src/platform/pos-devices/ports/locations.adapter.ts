import { Injectable } from '@nestjs/common';
import { LocationsService } from 'src/stock';
import type { LocationsPort } from './locations.port';

// The only place in `platform` that talks to the `stock` context's concrete
// service. In-process today; an HTTP client the day `stock` becomes its own
// service.
@Injectable()
export class LocationsAdapter implements LocationsPort {
  constructor(private readonly locations: LocationsService) {}

  assertAccountLocation(accountId: number, locationId: number): Promise<void> {
    return this.locations.assertAccountLocation(accountId, locationId);
  }
}
