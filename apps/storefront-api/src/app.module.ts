import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { createRedisConnection } from 'queue';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AppKeyModule } from './modules/app-key/app-key.module';
import { ProductsModule } from './modules/products/products.module';
import { CartModule } from './modules/cart/cart.module';
import { CheckoutModule } from './modules/checkout/checkout.module';
import { AuthModule } from './modules/auth/auth.module';
import { CustomerModule } from './modules/customer/customer.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    // 5s command timeout — this app only ever enqueues, never blocks
    // waiting on jobs, so a bounded timeout lets a Redis outage fail fast
    // instead of hanging the request indefinitely (see createRedisConnection)
    BullModule.forRoot({
      connection: createRedisConnection({ commandTimeout: 5000 }),
    }),
    DatabaseModule,
    AppKeyModule,
    ProductsModule,
    CartModule,
    CheckoutModule,
    AuthModule,
    CustomerModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
