import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery } from '@nestjs/swagger';
import { DashboardService, LOW_STOCK_DEFAULT_LIMIT } from './dashboard.service';
import { DashboardLowStock } from './entities/dashboard-low-stock.entity';
import { DashboardSummary } from './entities/dashboard-summary.entity';
import { DashboardSales } from './entities/dashboard-sales.entity';
import { DashboardSalesTimeseries } from './entities/dashboard-sales-timeseries.entity';
import { DashboardRangeQueryDto } from './dto/dashboard-range-query.dto';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
  NoMfaFactorRequired,
} from 'src/shared/auth/decorators';

@Controller('dashboard')
@NoMfaFactorRequired()
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @RequirePermissions('dashboard:read')
  @Get()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: DashboardSummary })
  getSummary(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboardService.getSummary(user.accountId);
  }

  // range-scoped money: net sales, orders, AOV + the previous period (OS-669)
  @RequirePermissions('dashboard:read')
  @Get('sales')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: DashboardSales })
  getSales(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardRangeQueryDto,
  ) {
    return this.dashboardService.getSales(user.accountId, query);
  }

  // the same money bucketed by day/week/month for the trend charts (OS-670)
  @RequirePermissions('dashboard:read')
  @Get('sales/timeseries')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: DashboardSalesTimeseries })
  getSalesTimeseries(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DashboardRangeQueryDto,
  ) {
    return this.dashboardService.getSalesTimeseries(user.accountId, query);
  }

  // variants at or below the low-stock threshold, most urgent first (OS-195)
  @RequirePermissions('dashboard:read')
  @Get('low-stock')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: DashboardLowStock })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `1–50, clamped; default ${LOW_STOCK_DEFAULT_LIMIT}`,
  })
  getLowStock(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit', new DefaultValuePipe(LOW_STOCK_DEFAULT_LIMIT), ParseIntPipe)
    limit: number,
  ) {
    return this.dashboardService.getLowStock(user.accountId, limit);
  }
}
