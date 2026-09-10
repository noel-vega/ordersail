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
import { ApiKeysService } from './api-keys.service';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';
import { ApiKeyDto } from './dto/api-key.dto';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@ApiBearerAuth('JWT-auth')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Get()
  @RequirePermissions('api_keys:read')
  @ApiOkResponse({ type: ApiKeyDto, isArray: true })
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.apiKeysService.listForAccount(user.accountId);
  }

  @Post()
  @RequirePermissions('api_keys:write')
  @ApiCreatedResponse({ type: ApiKeyDto })
  async create(
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.apiKeysService.createForAccount(user.accountId, dto.label);
  }

  @Delete(':id')
  @RequirePermissions('api_keys:write')
  @ApiOkResponse({ type: ApiKeyDto })
  async revoke(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const revoked = await this.apiKeysService.revokeForAccount(
      id,
      user.accountId,
    );
    if (!revoked) throw new NotFoundException();
    return revoked;
  }
}
