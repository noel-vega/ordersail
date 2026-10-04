import { Module } from '@nestjs/common';
import { QueuesModule } from '../../queues.module';
import { OrdersProcessor } from './orders.processor';

@Module({
  // OrdersProcessor also produces order-confirmation jobs onto the email
  // queue, through QueuesModule's email client
  imports: [QueuesModule],
  providers: [OrdersProcessor],
  // exported so HealthModule can query the same singleton instance's
  // isRunning()/lastActiveAt — see OrdersProcessor.getLiveness()
  exports: [OrdersProcessor],
})
export class OrdersModule {}
