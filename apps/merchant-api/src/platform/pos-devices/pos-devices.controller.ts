import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { PosDevicesService } from './pos-devices.service';
import { CreatePosDeviceDto } from './dto/create-pos-device.dto';
import { UpdatePosDeviceDto } from './dto/update-pos-device.dto';
import { PosDevice } from './entities/pos-device.entity';
import { PosDevicePairing } from './entities/pos-device-pairing.entity';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@ApiBearerAuth('JWT-auth')
@Controller('pos-devices')
export class PosDevicesController {
  constructor(private readonly posDevicesService: PosDevicesService) {}

  @Post()
  @RequirePermissions('pos_devices:write')
  @ApiCreatedResponse({ type: PosDevicePairing })
  create(
    @Body() dto: CreatePosDeviceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.posDevicesService.create(dto, user.accountId, user.sub);
  }

  @Get()
  @RequirePermissions('pos_devices:read')
  @ApiOkResponse({ type: [PosDevice] })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.posDevicesService.findAll(user.accountId);
  }

  @Patch(':id')
  @RequirePermissions('pos_devices:write')
  @ApiOkResponse({ type: PosDevice })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePosDeviceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.posDevicesService.update(+id, dto, user.accountId);
  }

  @Post(':id/revoke')
  @RequirePermissions('pos_devices:write')
  @ApiOkResponse({ type: PosDevice })
  revoke(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.posDevicesService.revoke(+id, user.accountId);
  }

  @Post(':id/rotate-pairing')
  @RequirePermissions('pos_devices:write')
  @ApiOkResponse({ type: PosDevicePairing })
  rotatePairing(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.posDevicesService.rotatePairing(+id, user.accountId);
  }
}
