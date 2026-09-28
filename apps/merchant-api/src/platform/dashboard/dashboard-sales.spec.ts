import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  insertAccount,
  insertOrder,
  insertOrderPayment,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { DashboardService, granularityFor } from './dashboard.service';
import { SALES_PORT } from './ports/sales.port';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      DashboardService,
      { provide: DRIZZLE, useValue: db },
      { provide: SALES_PORT, useValue: {} },
    ],
  }).compile();
  return ref.get(DashboardService);
}

const at = (iso: string) => new Date(iso);

// pinned so the fixed test dates are never "after today" (OS-193)
const NOW = new Date('2027-01-01T12:00:00Z');
const getSales = (
  service: DashboardService,
  accountId: number,
  query: Parameters<DashboardService['getSales']>[1],
) => service.getSales(accountId, query, NOW);

// a paid order with its tender, and optionally a refund row dated `refundAt`
async function sale(
  accountId: number,
  opts: {
    cents: number;
    placedAt: string;
    status?:
      | 'paid'
      | 'partially_refunded'
      | 'refunded'
      | 'canceled'
      | 'pending'
      | 'payment_failed';
    refund?: { cents: number; at: string };
  },
) {
  const order = await insertOrder(db, {
    accountId,
    status: opts.status ?? 'paid',
    amountTotalCents: opts.cents,
    createdAt: at(opts.placedAt),
  });
  const tender = await insertOrderPayment(db, {
    orderId: order.id,
    amountCents: opts.cents,
    createdAt: at(opts.placedAt),
  });
  if (opts.refund) {
    await insertOrderPayment(db, {
      orderId: order.id,
      amountCents: -opts.refund.cents,
      parentPaymentId: tender.id,
      stripeRefundId: `re_${order.id}`,
      createdAt: at(opts.refund.at),
    });
  }
  return order;
}

const zero = {
  grossSalesCents: 0,
  refundsCents: 0,
  netSalesCents: 0,
  orderCount: 0,
  averageOrderValueCents: 0,
};

describe('DashboardService.getSales (OS-669)', () => {
  it('fresh account → zeros for both periods (OS-173 empty case)', async () => {
    const account = await insertAccount(db);
    const service = await build();

    await expect(
      getSales(service, account.id, { from: '2026-09-01', to: '2026-09-30' }),
    ).resolves.toEqual({
      range: {
        from: '2026-09-01',
        to: '2026-09-30',
        today: '2027-01-01',
        previousFrom: '2026-08-02',
        previousTo: '2026-08-31',
        timezone: 'UTC',
      },
      current: zero,
      previous: zero,
    });
  });

  it('gross, refunds, net, orders and AOV for the window', async () => {
    const account = await insertAccount(db);
    await sale(account.id, { cents: 1000, placedAt: '2026-09-02T12:00:00Z' });
    await sale(account.id, {
      cents: 3000,
      placedAt: '2026-09-03T12:00:00Z',
      status: 'partially_refunded',
      refund: { cents: 500, at: '2026-09-04T12:00:00Z' },
    });
    await sale(account.id, {
      cents: 2001,
      placedAt: '2026-09-05T12:00:00Z',
      status: 'refunded',
      refund: { cents: 2001, at: '2026-09-06T12:00:00Z' },
    });
    const service = await build();

    const { current } = await getSales(service, account.id, {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(current).toEqual({
      grossSalesCents: 6001,
      refundsCents: 2501,
      netSalesCents: 3500,
      orderCount: 3,
      averageOrderValueCents: 2000, // 6001 / 3 = 2000.33
    });
  });

  it('excludes canceled / pending / payment_failed — orders AND their refunds', async () => {
    const account = await insertAccount(db);
    await sale(account.id, { cents: 1000, placedAt: '2026-09-02T12:00:00Z' });
    // a paid web order canceled later: refund row written, status canceled
    await sale(account.id, {
      cents: 4000,
      placedAt: '2026-09-02T12:00:00Z',
      status: 'canceled',
      refund: { cents: 4000, at: '2026-09-03T12:00:00Z' },
    });
    // a POS cancel: no refund row
    await sale(account.id, {
      cents: 700,
      placedAt: '2026-09-02T12:00:00Z',
      status: 'canceled',
    });
    await sale(account.id, {
      cents: 900,
      placedAt: '2026-09-02T12:00:00Z',
      status: 'pending',
    });
    await sale(account.id, {
      cents: 800,
      placedAt: '2026-09-02T12:00:00Z',
      status: 'payment_failed',
    });
    const service = await build();

    const { current } = await getSales(service, account.id, {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(current).toMatchObject({
      grossSalesCents: 1000,
      refundsCents: 0,
      netSalesCents: 1000,
      orderCount: 1,
    });
  });

  it("a refund lands in the window it was issued, not the order's", async () => {
    const account = await insertAccount(db);
    await sale(account.id, {
      cents: 5000,
      placedAt: '2026-08-20T12:00:00Z',
      status: 'partially_refunded',
      refund: { cents: 1200, at: '2026-09-10T12:00:00Z' },
    });
    const service = await build();

    const { current, previous } = await getSales(service, account.id, {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(current).toMatchObject({
      grossSalesCents: 0,
      refundsCents: 1200,
      netSalesCents: -1200,
      orderCount: 0,
    });
    expect(previous).toMatchObject({
      grossSalesCents: 5000,
      refundsCents: 0,
      orderCount: 1,
    });
  });

  it('cuts days at local midnight in the account timezone', async () => {
    const account = await insertAccount(db, { timezone: 'America/New_York' });
    // 2026-09-30 23:30 EDT = 2026-10-01 03:30 UTC → in a range ending the 30th
    await sale(account.id, { cents: 100, placedAt: '2026-10-01T03:30:00Z' });
    // 2026-10-01 00:30 EDT = 04:30 UTC → the next day, out
    await sale(account.id, { cents: 200, placedAt: '2026-10-01T04:30:00Z' });
    // 2026-08-31 23:30 EDT = 2026-09-01 03:30 UTC → the day before, out
    await sale(account.id, { cents: 400, placedAt: '2026-09-01T03:30:00Z' });
    const service = await build();

    const sales = await getSales(service, account.id, {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(sales.range.timezone).toBe('America/New_York');
    expect(sales.current.grossSalesCents).toBe(100);
    expect(sales.previous.grossSalesCents).toBe(400);
  });

  it('gets the boundaries right across a DST change', async () => {
    // New York leaves DST on 2026-11-01: that day is 25 hours long
    const account = await insertAccount(db, { timezone: 'America/New_York' });
    // 2026-11-01 00:30 EDT (UTC-4) = 04:30 UTC → first minutes of the range
    await sale(account.id, { cents: 1, placedAt: '2026-11-01T04:30:00Z' });
    // 2026-11-01 23:30 EST (UTC-5) = 2026-11-02 04:30 UTC → last hour, in
    await sale(account.id, { cents: 10, placedAt: '2026-11-02T04:30:00Z' });
    // 2026-11-02 00:30 EST = 05:30 UTC → next day, out
    await sale(account.id, { cents: 100, placedAt: '2026-11-02T05:30:00Z' });
    // 2026-10-31 23:30 EDT = 2026-11-01 03:30 UTC → day before, out
    await sale(account.id, { cents: 1000, placedAt: '2026-11-01T03:30:00Z' });
    const service = await build();

    const { current, previous } = await getSales(service, account.id, {
      from: '2026-11-01',
      to: '2026-11-01',
    });
    expect(current.grossSalesCents).toBe(11);
    expect(previous.grossSalesCents).toBe(1000);
  });

  it('previous covers the equal-length window just before', async () => {
    const account = await insertAccount(db);
    await sale(account.id, { cents: 100, placedAt: '2026-09-07T23:59:00Z' }); // current
    await sale(account.id, { cents: 200, placedAt: '2026-08-31T00:00:00Z' }); // previous (first day)
    await sale(account.id, { cents: 400, placedAt: '2026-08-24T23:59:00Z' }); // neither
    const service = await build();

    const sales = await getSales(service, account.id, {
      from: '2026-09-07',
      to: '2026-09-07',
    });
    expect(sales.range).toMatchObject({
      previousFrom: '2026-09-06',
      previousTo: '2026-09-06',
    });

    const week = await getSales(service, account.id, {
      from: '2026-09-01',
      to: '2026-09-07',
    });
    expect(week.range).toMatchObject({
      previousFrom: '2026-08-25',
      previousTo: '2026-08-31',
    });
    expect(week.current.grossSalesCents).toBe(100);
    expect(week.previous.grossSalesCents).toBe(200);
  });

  it('is scoped to the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    await sale(other.id, { cents: 999, placedAt: '2026-09-02T12:00:00Z' });
    const service = await build();

    const { current } = await getSales(service, account.id, {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(current).toEqual(zero);
  });

  it('400s a bad range', async () => {
    const account = await insertAccount(db);
    const service = await build();

    await expect(
      getSales(service, account.id, { from: '2026-09-30', to: '2026-09-01' }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('granularityFor (OS-670)', () => {
  it.each([
    [1, 'day'],
    [31, 'day'],
    [32, 'week'],
    [184, 'week'],
    [185, 'month'],
    [731, 'month'],
  ])('%i days → %s', (days, granularity) => {
    expect(granularityFor(days)).toBe(granularity);
  });
});

describe('DashboardService.getSalesTimeseries (OS-670)', () => {
  const getTimeseries = (
    service: DashboardService,
    accountId: number,
    query: Parameters<DashboardService['getSalesTimeseries']>[1],
  ) => service.getSalesTimeseries(accountId, query, NOW);

  const point = (date: string, over: Partial<typeof zero> = {}) => {
    const { averageOrderValueCents: _aov, ...money } = zero;
    return { date, ...money, ...over };
  };

  it('7 days → 7 zero-filled day points', async () => {
    const account = await insertAccount(db);
    await sale(account.id, { cents: 1000, placedAt: '2026-09-03T12:00:00Z' });
    await sale(account.id, { cents: 500, placedAt: '2026-09-03T18:00:00Z' });
    const service = await build();

    await expect(
      getTimeseries(service, account.id, {
        from: '2026-09-01',
        to: '2026-09-07',
      }),
    ).resolves.toEqual({
      granularity: 'day',
      from: '2026-09-01',
      to: '2026-09-07',
      timezone: 'UTC',
      points: [
        point('2026-09-01'),
        point('2026-09-02'),
        point('2026-09-03', {
          grossSalesCents: 1500,
          netSalesCents: 1500,
          orderCount: 2,
        }),
        point('2026-09-04'),
        point('2026-09-05'),
        point('2026-09-06'),
        point('2026-09-07'),
      ],
    });
  });

  it('90 days → Monday-start weeks; 12 months → months', async () => {
    const account = await insertAccount(db);
    const service = await build();

    // 2026-09-03 is a Thursday → the first bucket is Monday 2026-08-31
    const weeks = await getTimeseries(service, account.id, {
      from: '2026-09-03',
      to: '2026-12-01',
    });
    expect(weeks.granularity).toBe('week');
    // the range itself, not the first bucket's start — a client clamps to it
    expect([weeks.from, weeks.to]).toEqual(['2026-09-03', '2026-12-01']);
    expect(weeks.points[0].date).toBe('2026-08-31');
    expect(weeks.points.at(-1)?.date).toBe('2026-11-30');
    expect(weeks.points).toHaveLength(14);

    const months = await getTimeseries(service, account.id, {
      from: '2026-01-02',
      to: '2027-01-01',
    });
    expect(months.granularity).toBe('month');
    expect(months.points.map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
    ]);
  });

  it('returns the range a preset resolved to', async () => {
    const account = await insertAccount(db);
    const service = await build();

    // NOW is 2027-01-01 → the last 7 days, today included
    const series = await getTimeseries(service, account.id, { range: '7d' });
    expect([series.from, series.to]).toEqual(['2026-12-26', '2027-01-01']);
  });

  it('a partial first bucket counts only in-range sales', async () => {
    const account = await insertAccount(db);
    // Monday 2026-08-31: same week as the range's start, but before it
    await sale(account.id, { cents: 999, placedAt: '2026-08-31T12:00:00Z' });
    await sale(account.id, { cents: 100, placedAt: '2026-09-04T12:00:00Z' });
    const service = await build();

    const { points } = await getTimeseries(service, account.id, {
      from: '2026-09-03',
      to: '2026-12-01',
    });
    expect(points[0]).toEqual(
      point('2026-08-31', {
        grossSalesCents: 100,
        netSalesCents: 100,
        orderCount: 1,
      }),
    );
  });

  it('buckets by local day in the account timezone', async () => {
    const account = await insertAccount(db, { timezone: 'America/New_York' });
    // 2026-09-02 23:30 EDT = 2026-09-03 03:30 UTC → the 2nd, locally
    await sale(account.id, { cents: 100, placedAt: '2026-09-03T03:30:00Z' });
    // 2026-09-03 00:30 EDT = 04:30 UTC → the 3rd
    await sale(account.id, { cents: 200, placedAt: '2026-09-03T04:30:00Z' });
    const service = await build();

    const series = await getTimeseries(service, account.id, {
      from: '2026-09-01',
      to: '2026-09-03',
    });
    expect(series.timezone).toBe('America/New_York');
    expect(series.points.map((p) => [p.date, p.grossSalesCents])).toEqual([
      ['2026-09-01', 0],
      ['2026-09-02', 100],
      ['2026-09-03', 200],
    ]);
  });

  it("a refund lands in its own bucket, not the order's", async () => {
    const account = await insertAccount(db);
    await sale(account.id, {
      cents: 5000,
      placedAt: '2026-09-02T12:00:00Z',
      status: 'partially_refunded',
      refund: { cents: 1200, at: '2026-09-05T12:00:00Z' },
    });
    const service = await build();

    const { points } = await getTimeseries(service, account.id, {
      from: '2026-09-01',
      to: '2026-09-07',
    });
    expect(points[1]).toEqual(
      point('2026-09-02', {
        grossSalesCents: 5000,
        netSalesCents: 5000,
        orderCount: 1,
      }),
    );
    expect(points[4]).toEqual(
      point('2026-09-05', { refundsCents: 1200, netSalesCents: -1200 }),
    );
  });

  it('points sum to /dashboard/sales current for the same range', async () => {
    const account = await insertAccount(db, { timezone: 'America/New_York' });
    // near local midnights, across the 2026-11-01 DST change, with refunds
    // in and after the range
    await sale(account.id, { cents: 1000, placedAt: '2026-08-15T03:59:00Z' });
    await sale(account.id, { cents: 1111, placedAt: '2026-08-15T04:01:00Z' });
    await sale(account.id, {
      cents: 2222,
      placedAt: '2026-09-01T12:00:00Z',
      status: 'partially_refunded',
      refund: { cents: 250, at: '2026-09-02T03:30:00Z' },
    });
    await sale(account.id, {
      cents: 3333,
      placedAt: '2026-10-10T04:30:00Z',
      status: 'refunded',
      refund: { cents: 3333, at: '2026-11-20T12:00:00Z' },
    });
    await sale(account.id, { cents: 4444, placedAt: '2026-11-01T04:30:00Z' });
    await sale(account.id, { cents: 5555, placedAt: '2026-11-02T04:30:00Z' });
    await sale(account.id, { cents: 6666, placedAt: '2026-11-02T05:30:00Z' });
    await sale(account.id, {
      cents: 7777,
      placedAt: '2026-09-09T12:00:00Z',
      status: 'canceled',
      refund: { cents: 7777, at: '2026-09-10T12:00:00Z' },
    });
    const service = await build();

    for (const query of [
      { from: '2026-08-15', to: '2026-09-14' }, // day
      { from: '2026-08-15', to: '2026-11-13' }, // week
      { from: '2026-01-15', to: '2026-12-31' }, // month
    ]) {
      const [{ current }, { points }] = await Promise.all([
        getSales(service, account.id, query),
        getTimeseries(service, account.id, query),
      ]);
      const sum = (key: Exclude<keyof typeof zero, 'averageOrderValueCents'>) =>
        points.reduce((total, p) => total + p[key], 0);
      expect({
        grossSalesCents: sum('grossSalesCents'),
        refundsCents: sum('refundsCents'),
        netSalesCents: sum('netSalesCents'),
        orderCount: sum('orderCount'),
      }).toEqual({
        grossSalesCents: current.grossSalesCents,
        refundsCents: current.refundsCents,
        netSalesCents: current.netSalesCents,
        orderCount: current.orderCount,
      });
      expect(current.orderCount).toBeGreaterThan(0);
    }
  });

  it('is scoped to the account', async () => {
    const account = await insertAccount(db);
    const other = await insertAccount(db);
    await sale(other.id, { cents: 999, placedAt: '2026-09-02T12:00:00Z' });
    const service = await build();

    const { points } = await getTimeseries(service, account.id, {
      from: '2026-09-01',
      to: '2026-09-03',
    });
    expect(points.every((p) => p.orderCount === 0)).toBe(true);
  });

  it('400s a bad range', async () => {
    const account = await insertAccount(db);
    const service = await build();

    await expect(
      getTimeseries(service, account.id, {
        from: '2026-09-30',
        to: '2026-09-01',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
