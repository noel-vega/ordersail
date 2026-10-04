import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { OrdersModule } from '../orders/orders.module';
import { EmailModule } from '../email/email.module';
import { QueuesModule } from '../../queues.module';

@Module({
  imports: [
    TerminusModule,
    // HealthService's getWaitingCount()/getBackend().client — the shared
    // Queue clients, not consumers
    QueuesModule,
    OrdersModule,
    EmailModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
