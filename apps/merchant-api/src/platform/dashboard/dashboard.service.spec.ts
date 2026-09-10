import { Test } from '@nestjs/testing';
import {
  insertAccount,
  insertLocation,
  insertProductWithVariants,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { DashboardService } from './dashboard.service';
import { SALES_PORT } from './ports/sales.port';

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      DashboardService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: SALES_PORT,
        useValue: {
          recentOrders: () => Promise.resolve([]),
          recentCustomers: () => Promise.resolve([]),
        },
      },
    ],
  }).compile();
  return ref.get(DashboardService);
}

describe('DashboardService.getSummary — fresh account (OS-173)', () => {
  it('returns zeroes and empty lists with no orders or products', async () => {
    const account = await insertAccount(db);
    const service = await build();

    await expect(service.getSummary(account.id)).resolves.toEqual({
      orderCount: 0,
      revenueCents: 0,
      outOfStockCount: 0,
      recentOrders: [],
      recentCustomers: [],
    });
  });

  it('counts an unstocked variant as out of stock without throwing', async () => {
    const account = await insertAccount(db);
    await insertLocation(db, { accountId: account.id, withAddress: false });
    await insertProductWithVariants(db, {
      accountId: account.id,
      variants: [{ priceCents: 1000 }], // no stock rows
    });
    const service = await build();

    const summary = await service.getSummary(account.id);
    expect(summary.outOfStockCount).toBe(1);
    expect(summary.orderCount).toBe(0);
  });
});
