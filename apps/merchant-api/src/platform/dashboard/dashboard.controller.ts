import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { DashboardSummary } from './entities/dashboard-summary.entity';
import { DashboardSales } from './entities/dashboard-sales.entity';
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
}
