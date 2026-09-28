import { Module } from '@nestjs/common';
import { Shippo } from 'shippo';
import { env } from 'src/shared/env';
import { FulfillmentsController } from './fulfillments.controller';
import { FulfillmentsService } from './fulfillments.service';
import { SHIPPO } from './fulfillments.constants';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [OrdersModule],
  controllers: [FulfillmentsController],
  providers: [
    FulfillmentsService,
    {
      // same account as storefront-api's checkout-time rate quoting —
      // platform-owned. timeoutMs bounds a hung Shippo call so it can't hold
      // a request open (label purchase is the slow op — 20s headroom).
      provide: SHIPPO,
      useFactory: (): Shippo =>
        new Shippo({ apiKeyHeader: env.SHIPPO_API_KEY, timeoutMs: 20_000 }),
    },
  ],
})
export class FulfillmentsModule {}
