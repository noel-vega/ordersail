import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { LocationsModule } from '../locations/locations.module';

@Module({
  imports: [LocationsModule],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
