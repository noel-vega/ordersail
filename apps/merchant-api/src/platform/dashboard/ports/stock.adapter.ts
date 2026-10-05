import { Injectable } from '@nestjs/common';
import { VariantStockService } from 'src/stock';
import type { DashboardLowStock } from '../entities/dashboard-low-stock.entity';
import type { StockPort, VariantStockCounts } from './stock.port';

// The only place in platform/dashboard that talks to the `stock` context's
// concrete services. In-process today; an HTTP client the day `stock` becomes
// its own service.
@Injectable()
export class StockAdapter implements StockPort {
  constructor(private readonly variantStock: VariantStockService) {}

  counts(accountId: number): Promise<VariantStockCounts> {
    return this.variantStock.counts(accountId);
  }

  // the first page of the inventory list's By variant low-stock view
  async lowStock(accountId: number, limit: number): Promise<DashboardLowStock> {
    const { items, lowStockThreshold } = await this.variantStock.findAll(
      limit,
      0,
      accountId,
      { lowStock: true },
    );
    return {
      // the card doesn't show the per-location breakdown
      items: items.map(({ locations: _locations, ...item }) => item),
      lowStockThreshold,
    };
  }
}
