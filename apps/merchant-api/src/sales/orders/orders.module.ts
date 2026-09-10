import { Module } from '@nestjs/common';
import { PaymentsModule } from 'src/payments';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { RefundsService } from './refunds.service';
import { CancelService } from './cancel.service';
import { DisputesService } from './disputes.service';
import { ChargeEventsHandler } from './charge-events.handler';
import { PAYMENTS_PORT } from './ports/payments.port';
import { PaymentsAdapter } from './ports/payments.adapter';

@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    RefundsService,
    CancelService,
    DisputesService,
    ChargeEventsHandler,
    { provide: PAYMENTS_PORT, useClass: PaymentsAdapter },
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
