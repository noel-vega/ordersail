import { WorkerHost } from '@nestjs/bullmq';
import type { BeforeApplicationShutdown } from '@nestjs/common';

// Base class for every @Processor: closes its Worker, which waits for the
// in-flight job, before any Queue client closes.
//
// @nestjs/bullmq closes @Processor Workers from its global core module, and
// Nest runs global modules' onApplicationShutdown *last* — after
// registerQueue's Queue clients have already quit their connections (each
// owns one since OS-722). A job still running then would hit a closed
// client: OrdersProcessor's order-confirmation enqueue would fail into its
// catch, the job would complete, and the email would never be sent.
// beforeApplicationShutdown runs before every onApplicationShutdown, so the
// job finishes with the queues still open. Worker.close() is idempotent, so
// @nestjs/bullmq's own close later is a no-op.
export abstract class DrainingWorkerHost
  extends WorkerHost
  implements BeforeApplicationShutdown
{
  async beforeApplicationShutdown() {
    await this.worker.close();
  }
}
