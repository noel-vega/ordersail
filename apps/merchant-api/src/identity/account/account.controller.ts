import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { AccountService } from './account.service';
import { UpdateAccountDto } from './dto/update-account.dto';
import { Account } from './entities/account.entity';
import {
  CurrentUser,
  GrantedPermissions,
  RequirePermissions,
  type AuthenticatedUser,
  NoMfaFactorRequired,
} from 'src/shared/auth/decorators';

@Controller('account')
@NoMfaFactorRequired()
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Get()
  @RequirePermissions('account:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Account })
  findOne(@CurrentUser() user: AuthenticatedUser) {
    return this.accountService.findOne(user.accountId);
  }

  // requireMfa is deliberately not folded into @RequirePermissions() here —
  // that would gate the whole endpoint (including the low-stakes
  // phone/email fields) on the new key too. account:write stays the bar
  // for ordinary settings edits; a second, narrower check below applies
  // only when the security-sensitive field is actually present, so a
  // custom role holding account:write (but not account:manage_security)
  // can't toggle the org-wide MFA requirement.
  @Patch()
  @RequirePermissions('account:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Account })
  @ApiForbiddenResponse()
  update(
    @Body() dto: UpdateAccountDto,
    @CurrentUser() user: AuthenticatedUser,
    @GrantedPermissions() granted: Set<string> | undefined,
  ) {
    if (
      dto.requireMfa !== undefined &&
      !granted?.has('account:manage_security')
    ) {
      throw new ForbiddenException('Missing required permission');
    }
    return this.accountService.update(user.accountId, dto);
  }
}
