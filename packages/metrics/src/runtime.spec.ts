import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { createInstrumentations, flushMetrics, shutdownMetrics, startMetrics } from './index.ts';

afterEach(() => shutdownMetrics(0));

async function exportedOnce(): Promise<Map<string, MetricData>> {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  assert.equal(startMetrics({ service: 'spec', exporter }), true);
  // some allocation and a few event-loop turns, so the collectors have data
  let junk: unknown[] | null = Array.from({ length: 50_000 }, (_, i) => ({ i, s: 'x'.repeat(16) }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  junk = null;
  await flushMetrics();
  const byName = new Map<string, MetricData>();
  for (const batch of exporter.getMetrics()) {
    for (const scope of batch.scopeMetrics) for (const metric of scope.metrics) byName.set(metric.descriptor.name, metric);
  }
  return byName;
}

describe('runtime and process metrics', () => {
  it('the instrumentation list is pinned', () => {
    assert.deepEqual(
      createInstrumentations().map((instrumentation) => instrumentation.instrumentationName),
      ['@opentelemetry/instrumentation-runtime-node'],
    );
  });

  it('exports what the runtime dashboard reads', async () => {
    const metrics = await exportedOnce();
    for (const name of [
      'nodejs.eventloop.delay.p99',
      'nodejs.eventloop.delay.max',
      'nodejs.eventloop.utilization',
      'v8js.memory.heap.used',
      'v8js.memory.heap.space.size',
      'process.cpu.time',
      'process.memory.usage',
    ]) {
      assert.ok(metrics.has(name), `${name} not exported`);
    }
  });

  it('keeps the allowed attributes: heap by space, CPU by mode', async () => {
    const metrics = await exportedOnce();

    const spaces = metrics.get('v8js.memory.heap.used')!.dataPoints.map((p) => p.attributes['v8js.heap.space.name']);
    assert.ok(spaces.includes('old_space') && spaces.includes('new_space'), String(spaces));

    const cpu = metrics.get('process.cpu.time')!;
    assert.deepEqual(cpu.dataPoints.map((p) => p.attributes['cpu.mode']).sort(), ['system', 'user']);
    for (const point of cpu.dataPoints) assert.ok((point.value as number) > 0);
    assert.ok((metrics.get('process.memory.usage')!.dataPoints[0].value as number) > 10_000_000, 'RSS in bytes');

    const gc = metrics.get('v8js.gc.duration');
    if (gc) assert.equal(gc.dataPointType, DataPointType.EXPONENTIAL_HISTOGRAM);
  });

  it('stays well inside the series budget: under 100 per process', async () => {
    const metrics = await exportedOnce();
    const series = [...metrics.values()].reduce((total, metric) => total + metric.dataPoints.length, 0);
    assert.ok(series < 100, `${series} series`);
    // so a reviewer sees the real number in the test output
    console.log(`runtime + process series per process: ${series}`);
  });
});
