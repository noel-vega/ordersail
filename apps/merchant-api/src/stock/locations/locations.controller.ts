import {
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Post,
  Patch,
  Param,
  ParseIntPipe,
  Query,
  Body,
  NotFoundException,
} from '@nestjs/common';
import { LocationsService } from './locations.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { Location } from './entities/location.entity';
import { PaginatedLocations } from './entities/paginated-locations.entity';
import {
  CurrentUser,
  RequirePermissions,
  AuthenticatedOnly,
  type AuthenticatedUser,
  NoMfaFactorRequired,
} from 'src/shared/auth/decorators';

@Controller('locations')
@NoMfaFactorRequired()
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Post()
  @RequirePermissions('locations:write')
  @ApiBearerAuth('JWT-auth')
  @ApiCreatedResponse({ type: Location })
  create(
    @Body() createLocationDto: CreateLocationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.locationsService.create(createLocationDto, user.accountId);
  }

  // not gated by @RequirePermissions — a location's name and address are the
  // merchant's own business details, and every staff member working stock,
  // orders or POS needs them to know where things are. Same precedent as
  // GET /roles: reading isn't sensitive, only creating/editing/deleting is.
  @AuthenticatedOnly()
  @Get()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedLocations })
  @ApiQuery({ name: 'q', required: false, description: 'name match' })
  findAll(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
  ) {
    return this.locationsService.findAll(limit, offset, user.accountId, q);
  }

  @Patch(':id')
  @RequirePermissions('locations:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Location })
  async update(
    @Param('id') id: string,
    @Body() updateLocationDto: UpdateLocationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const location = await this.locationsService.update(
      +id,
      updateLocationDto,
      user.accountId,
    );
    if (!location) throw new NotFoundException();
    return location;
  }

  @Delete(':id')
  @RequirePermissions('locations:delete')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Location })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const location = await this.locationsService.remove(+id, user.accountId);
    if (!location) throw new NotFoundException();
    return location;
  }
}
