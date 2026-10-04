import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { bullmqConnectionOptions } from 'queue';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './shared/database/database.module';
import { StorageModule } from './shared/storage/storage.module';
import { EmailModule } from './shared/email/email.module';
import { EventsModule } from './shared/events';
import { IdentityModule } from './identity';
import { CatalogModule } from './catalog';
import { StockModule } from './stock';
import { SalesModule } from './sales';
import { PaymentsModule } from './payments';
import { PlatformModule } from './platform';

@Module({
  imports: [
    // 5s command timeout — this app only ever enqueues, never blocks
    // waiting on jobs, so a bounded timeout lets a Redis outage fail fast
    // instead of hanging the request indefinitely (see bullmqConnectionOptions)
    BullModule.forRoot({
      connection: bullmqConnectionOptions({ commandTimeout: 5000 }),
    }),
    // shared kernel (@Global)
    DatabaseModule,
    StorageModule,
    EmailModule,
    EventsModule,
    // bounded contexts
    IdentityModule,
    CatalogModule,
    StockModule,
    SalesModule,
    PaymentsModule,
    PlatformModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
