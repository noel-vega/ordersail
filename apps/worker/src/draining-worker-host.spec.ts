import {
  BullModule,
  InjectQueue,
  Processor,
  getQueueToken,
} from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { bullmqConnectionOptions } from 'queue';
import { DrainingWorkerHost } from './draining-worker-host';

// Real Redis (CI's service container / `npm run up`): the bug was in how
// Nest orders @nestjs/bullmq's shutdown hooks, which a mocked Queue can't see.
const prefix = `drain-spec-${process.pid}-${Date.now()}`;
const SOURCE = 'drain-source';
const SINK = 'drain-sink';

let started!: () => void;
const jobStarted = new Promise<void>((resolve) => (started = resolve));
let release!: () => void;
const gate = new Promise<void>((resolve) => (release = resolve));
const outcome: { enqueued?: boolean; error?: unknown } = {};

// stands in for OrdersProcessor: an in-flight job that, once it resumes,
// enqueues onto another queue (the order-confirmation email)
@Processor(SOURCE)
class GatedProcessor extends DrainingWorkerHost {
  constructor(@InjectQueue(SINK) private readonly sink: Queue) {
    super();
  }

  async process() {
    started();
    await gate;
    try {
      await this.sink.add('after-shutdown-began', {});
      outcome.enqueued = true;
    } catch (err) {
      outcome.error = err;
    }
  }
}

afterAll(async () => {
  for (const name of [SOURCE, SINK]) {
    const queue = new Queue(name, {
      connection: bullmqConnectionOptions(),
      prefix,
    });
    await queue.obliterate({ force: true });
    await queue.close();
  }
});

describe('DrainingWorkerHost', () => {
  it('lets an in-flight job enqueue before app.close() closes the queues', async () => {
    const ref = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({ connection: bullmqConnectionOptions(), prefix }),
        BullModule.registerQueue({ name: SOURCE }, { name: SINK }),
      ],
      providers: [GatedProcessor],
    }).compile();
    await ref.init();

    await ref.get<Queue>(getQueueToken(SOURCE)).add('gated', {});
    await jobStarted;

    const closing = ref.close();
    // long enough for every Queue client to have quit, had the Workers not
    // been drained first
    setTimeout(release, 300);
    await closing;

    expect(outcome.error).toBeUndefined();
    expect(outcome.enqueued).toBe(true);
  });

  it("doesn't throw when its Worker never started", async () => {
    class NeverStarted extends DrainingWorkerHost {
      async process() {}
    }
    await expect(
      new NeverStarted().beforeApplicationShutdown(),
    ).resolves.toBeUndefined();
  });
});
