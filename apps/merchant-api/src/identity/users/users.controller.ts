import {
  Controller,
  DefaultValuePipe,
  ForbiddenException,
  Get,
  Post,
  Patch,
  Param,
  ParseIntPipe,
  Query,
  Body,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { PermissionsService } from '../permissions/permissions.service';
import { CreateUserDto } from './dto/create-user.dto';
import { AssignRolesDto } from './dto/assign-roles.dto';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import { User } from './entities/user.entity';
import { PaginatedUsers } from './entities/paginated-users.entity';
import {
  CurrentUser,
  GrantedPermissions,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly permissionsService: PermissionsService,
  ) {}

  @Post()
  @RequirePermissions('users:write')
  @ApiBearerAuth('JWT-auth')
  @ApiCreatedResponse({ type: User })
  create(
    @Body() createUserDto: CreateUserDto,
    @CurrentUser() user: AuthenticatedUser,
    @GrantedPermissions() granted: Set<string> | undefined,
  ) {
    return this.usersService.create(
      createUserDto,
      user.accountId,
      user.sub,
      granted,
    );
  }

  @Get()
  @RequirePermissions('users:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedUsers })
  @ApiQuery({ name: 'q', required: false, description: 'name or email match' })
  findAll(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
  ) {
    return this.usersService.findAll(limit, offset, user.accountId, q);
  }

  @Get(':id')
  @RequirePermissions('users:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: User })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const found = await this.usersService.getById(id, user.accountId);
    if (!found) throw new NotFoundException();
    return found;
  }

  // no @RequirePermissions — a user may always edit their own name/phone;
  // editing anyone else needs users:write (checked in the handler)
  @Patch(':id')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: User })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserProfileDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (id !== user.sub) {
      const granted = await this.permissionsService.getEffectivePermissionKeys(
        user.sub,
      );
      if (!granted.has('users:write')) {
        throw new ForbiddenException(
          'Missing required permission: users:write',
        );
      }
    }

    const updated = await this.usersService.update(id, user.accountId, dto);
    if (!updated) throw new NotFoundException();
    return updated;
  }

  @Patch(':id/roles')
  @RequirePermissions('users:manage_roles')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: User })
  async updateRoles(
    @Param('id') id: string,
    @Body() assignRolesDto: AssignRolesDto,
    @CurrentUser() user: AuthenticatedUser,
    @GrantedPermissions() granted: Set<string> | undefined,
  ) {
    const updated = await this.usersService.updateRoles(
      +id,
      assignRolesDto.roleIds,
      user.accountId,
      user.sub,
      granted,
    );
    if (!updated) throw new NotFoundException();
    return updated;
  }

  @Post(':id/deactivate')
  @RequirePermissions('users:deactivate')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: User })
  async deactivate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const updated = await this.usersService.setDeactivated(
      id,
      user.accountId,
      true,
    );
    if (!updated) throw new NotFoundException();
    return updated;
  }

  @Post(':id/reactivate')
  @RequirePermissions('users:deactivate')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: User })
  async reactivate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const updated = await this.usersService.setDeactivated(
      id,
      user.accountId,
      false,
    );
    if (!updated) throw new NotFoundException();
    return updated;
  }
}
