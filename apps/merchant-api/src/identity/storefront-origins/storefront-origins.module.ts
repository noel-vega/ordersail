import { Module } from '@nestjs/common';
import { StorefrontOriginsController } from './storefront-origins.controller';
import { StorefrontOriginsService } from './storefront-origins.service';

@Module({
  controllers: [StorefrontOriginsController],
  providers: [StorefrontOriginsService],
  exports: [StorefrontOriginsService],
})
export class StorefrontOriginsModule {}
