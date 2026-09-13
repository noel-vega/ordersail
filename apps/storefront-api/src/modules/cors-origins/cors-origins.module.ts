import { Module } from '@nestjs/common';
import { CorsOriginsService } from './cors-origins.service';

@Module({
  providers: [CorsOriginsService],
  exports: [CorsOriginsService],
})
export class CorsOriginsModule {}
