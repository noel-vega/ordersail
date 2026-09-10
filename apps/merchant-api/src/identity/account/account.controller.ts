import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { AccountService } from './account.service';
import { UpdateAccountDto } from './dto/update-account.dto';
import { Account } from './entities/account.entity';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@Controller('account')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Get()
  @RequirePermissions('account:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Account })
  findOne(@CurrentUser() user: AuthenticatedUser) {
    return this.accountService.findOne(user.accountId);
  }

  @Patch()
  @RequirePermissions('account:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Account })
  update(
    @Body() dto: UpdateAccountDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.accountService.update(user.accountId, dto);
  }
}
