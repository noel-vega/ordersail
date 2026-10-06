import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { flushMetrics, shutdownMetrics, startMetrics } from './index.ts';

afterEach(() => shutdownMetrics(0));

function startedWithMemoryExporter(): InMemoryMetricExporter {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  assert.equal(startMetrics({ service: 'spec', exporter }), true);
  return exporter;
}

function metricNamed(batches: ResourceMetrics[], name: string) {
  const all = batches.flatMap((batch) => batch.scopeMetrics.flatMap((scope) => scope.metrics));
  const found = all.filter((metric) => metric.descriptor.name === name);
  assert.ok(found.length > 0, `no ${name} exported`);
  return found[found.length - 1];
}

describe('what a recorded metric becomes', () => {
  it('drops every attribute that is not on the allow-list', async () => {
    const exporter = startedWithMemoryExporter();
    const requests = metrics.getMeter('spec').createCounter('spec.requests');
    requests.add(1, { accountId: 42, 'http.route': '/orders/:id' });
    requests.add(1, { accountId: 43, userId: 7 });
    await flushMetrics();

    const metric = metricNamed(exporter.getMetrics(), 'spec.requests');
    // two tenants, one series: the attributes are gone before aggregation
    assert.equal(metric.dataPoints.length, 1);
    assert.deepEqual(metric.dataPoints[0].attributes, {});
    assert.equal(metric.dataPoints[0].value, 2);
  });

  it('records a histogram as an exponential histogram', async () => {
    const exporter = startedWithMemoryExporter();
    const latency = metrics.getMeter('spec').createHistogram('spec.duration', { unit: 's' });
    for (const seconds of [0.004, 0.02, 0.3, 1.5]) latency.record(seconds);
    await flushMetrics();

    const metric = metricNamed(exporter.getMetrics(), 'spec.duration');
    assert.equal(metric.dataPointType, DataPointType.EXPONENTIAL_HISTOGRAM);
    assert.equal(metric.aggregationTemporality, AggregationTemporality.CUMULATIVE);
    const point = metric.dataPoints[0].value as { count: number };
    assert.equal(point.count, 4);
  });

  it('tags every series with the service, its environment and a per-process instance', async () => {
    const exporter = startedWithMemoryExporter();
    metrics.getMeter('spec').createCounter('spec.ticks').add(1);
    await flushMetrics();

    const { attributes } = exporter.getMetrics()[0].resource;
    assert.equal(attributes['service.name'], 'spec');
    assert.equal(attributes['deployment.environment'], process.env.NODE_ENV ?? 'development');
    assert.match(String(attributes['service.instance.id']), /^[0-9a-f-]{36}$/);
  });

  it('a new process gets a new instance', async () => {
    let exporter = startedWithMemoryExporter();
    metrics.getMeter('spec').createCounter('spec.ticks').add(1);
    await flushMetrics();
    const first = exporter.getMetrics()[0].resource.attributes['service.instance.id'];
    await shutdownMetrics(0);

    exporter = startedWithMemoryExporter();
    metrics.getMeter('spec').createCounter('spec.ticks').add(1);
    await flushMetrics();
    assert.notEqual(exporter.getMetrics()[0].resource.attributes['service.instance.id'], first);
  });
});
