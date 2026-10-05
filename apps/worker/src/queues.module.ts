import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EMAIL_JOB_OPTIONS, QUEUE_NAMES } from 'queue';

// The worker's one Queue client per queue. Every BullModule.registerQueue
// builds its own client, with its own Redis connection (OS-722), so modules
// import this rather than registering a queue themselves. A Queue client is
// a producer/inspector handle — the consumers are the @Processor Workers.
@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_NAMES.ORDERS },
      // defaultJobOptions live on the Queue client, not the queue: they apply
      // to jobs added through it — OrdersProcessor's order-confirmation emails
      // (the same options storefront-api's email.module.ts sets)
      { name: QUEUE_NAMES.EMAIL, defaultJobOptions: EMAIL_JOB_OPTIONS },
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
