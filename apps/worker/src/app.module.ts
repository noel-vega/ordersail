import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { redisConnectionOptions } from 'queue';
import { AlertsModule } from './modules/alerts/alerts.module';
import { DatabaseModule } from './database/database.module';
import { EmailModule } from './modules/email/email.module';
import { OrdersModule } from './modules/orders/orders.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnectionOptions() }),
    AlertsModule,
    DatabaseModule,
    EmailModule,
    OrdersModule,
    HealthModule,
  ],
})
export class AppModule {}
