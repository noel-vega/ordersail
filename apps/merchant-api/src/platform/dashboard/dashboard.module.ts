import { Module } from '@nestjs/common';
import { CustomersModule, OrdersModule } from 'src/sales';
import { InventoryModule } from 'src/stock';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { SALES_PORT } from './ports/sales.port';
import { SalesAdapter } from './ports/sales.adapter';
import { STOCK_PORT } from './ports/stock.port';
import { StockAdapter } from './ports/stock.adapter';

@Module({
  imports: [OrdersModule, CustomersModule, InventoryModule],
  controllers: [DashboardController],
  providers: [
    DashboardService,
    { provide: SALES_PORT, useClass: SalesAdapter },
    { provide: STOCK_PORT, useClass: StockAdapter },
  ],
})
export class DashboardModule {}
