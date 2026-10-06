import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AggregationTemporality, AggregationType, InstrumentType } from '@opentelemetry/sdk-metrics';
import { ALLOWED_ATTRIBUTES, CARDINALITY_LIMIT, createExporter, createViews } from './index.ts';

// Pins what reaches Mimir. Changing any of these changes the series count —
// update the spec on purpose (docs/observability.md → Metrics).
describe('the metrics pipeline config', () => {
  it('allows exactly the runtime and process attributes', () => {
    assert.deepEqual([...ALLOWED_ATTRIBUTES].sort(), [
      'cpu.mode',
      'nodejs.eventloop.state',
      'v8js.gc.type',
      'v8js.heap.space.name',
      'v8js.resource.type',
    ]);
  });

  it('never allows a per-tenant or per-request attribute', () => {
    for (const key of ['accountId', 'userId', 'customerId', 'orderId', 'correlationId', 'url.full', 'url.path', 'email']) {
      assert.equal(ALLOWED_ATTRIBUTES.has(key), false, key);
    }
  });

  it('every instrument type matches exactly one View, each with the allow-list and the cardinality limit', () => {
    const views = createViews();
    const types = views.map((view) => view.instrumentType);
    assert.deepEqual([...types].sort(), Object.values(InstrumentType).sort());
    for (const view of views) {
      assert.equal(view.instrumentName, undefined, 'selects by type only, so Views never overlap');
      assert.equal(view.attributesProcessors?.length, 1, `${view.instrumentType}: allow-list`);
      assert.equal(view.aggregationCardinalityLimit, CARDINALITY_LIMIT);
    }
    assert.equal(CARDINALITY_LIMIT, 100);
  });

  it('histograms are exponential; everything else keeps its default aggregation', () => {
    for (const view of createViews()) {
      if (view.instrumentType === InstrumentType.HISTOGRAM) {
        assert.deepEqual(view.aggregation, { type: AggregationType.EXPONENTIAL_HISTOGRAM });
      } else {
        assert.equal(view.aggregation, undefined, String(view.instrumentType));
      }
    }
  });

  it('the OTLP exporter asks for cumulative temporality for every instrument type', async () => {
    const exporter = createExporter();
    for (const type of Object.values(InstrumentType)) {
      assert.equal(exporter.selectAggregationTemporality?.(type), AggregationTemporality.CUMULATIVE, type);
    }
    await exporter.shutdown();
  });
});
