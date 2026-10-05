// The dashboard read-model's view of the `stock` context. `stock` owns the
// one definition of out/low stock (variant stock summed across locations), so
// the dashboard's counts and Low stock card agree with GET /inventory/variants
// (OS-693). `dashboard.service` depends on this interface, never on stock's
// concrete services. See apps/merchant-api/ARCHITECTURE.md.
import type { VariantStockCounts } from 'src/stock';
import type { DashboardLowStock } from '../entities/dashboard-low-stock.entity';

export type { VariantStockCounts };

export const STOCK_PORT = Symbol('DASHBOARD_STOCK_PORT');

export interface StockPort {
  counts(accountId: number): Promise<VariantStockCounts>;
  // the first `limit` low or out variants, most urgent first
  lowStock(accountId: number, limit: number): Promise<DashboardLowStock>;
}
