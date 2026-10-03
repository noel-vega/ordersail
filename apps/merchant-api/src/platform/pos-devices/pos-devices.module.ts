import { Module } from '@nestjs/common';
import { PosDevicesController } from './pos-devices.controller';
import { PosDevicesService } from './pos-devices.service';
import { LocationsModule } from 'src/stock';
import { LOCATIONS_PORT } from './ports/locations.port';
import { LocationsAdapter } from './ports/locations.adapter';

@Module({
  imports: [LocationsModule],
  controllers: [PosDevicesController],
  providers: [
    PosDevicesService,
    { provide: LOCATIONS_PORT, useClass: LocationsAdapter },
  ],
})
export class PosDevicesModule {}
