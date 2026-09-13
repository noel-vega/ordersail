import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { StorefrontOriginsService } from './storefront-origins.service';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';
import { StorefrontOriginDto } from './dto/storefront-origin.dto';
import { CreateStorefrontOriginDto } from './dto/create-storefront-origin.dto';

@ApiBearerAuth('JWT-auth')
@Controller('storefront-origins')
export class StorefrontOriginsController {
  constructor(
    private readonly storefrontOriginsService: StorefrontOriginsService,
  ) {}

  @Get()
  @RequirePermissions('storefront_origins:read')
  @ApiOkResponse({ type: StorefrontOriginDto, isArray: true })
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.storefrontOriginsService.listForAccount(user.accountId);
  }

  @Post()
  @RequirePermissions('storefront_origins:write')
  @ApiCreatedResponse({ type: StorefrontOriginDto })
  async create(
    @Body() dto: CreateStorefrontOriginDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.storefrontOriginsService.createForAccount(
      user.accountId,
      dto.origin,
    );
  }

  @Delete(':id')
  @RequirePermissions('storefront_origins:write')
  @ApiOkResponse({ type: StorefrontOriginDto })
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const deleted = await this.storefrontOriginsService.deleteForAccount(
      id,
      user.accountId,
    );
    if (!deleted) throw new NotFoundException();
    return deleted;
  }
}
