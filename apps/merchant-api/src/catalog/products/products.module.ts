import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { LocationsModule } from 'src/stock';
import { LOCATIONS_PORT } from './ports/locations.port';
import { LocationsAdapter } from './ports/locations.adapter';

@Module({
  imports: [LocationsModule],
  controllers: [ProductsController],
  providers: [
    ProductsService,
    { provide: LOCATIONS_PORT, useClass: LocationsAdapter },
  ],
})
export class ProductsModule {}
