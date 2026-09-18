import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { Role } from './entities/role.entity';
import { RoleDetail } from './entities/role-detail.entity';
import {
  AuthenticatedOnly,
  CurrentUser,
  GrantedPermissions,
  RequirePermissions,
  type AuthenticatedUser,
  NoMfaFactorRequired,
} from 'src/shared/auth/decorators';

@Controller('roles')
@NoMfaFactorRequired()
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post()
  @RequirePermissions('roles:write')
  @ApiBearerAuth('JWT-auth')
  @ApiCreatedResponse({ type: RoleDetail })
  create(
    @Body() createRoleDto: CreateRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @GrantedPermissions() granted: Set<string> | undefined,
  ) {
    return this.rolesService.create(
      createRoleDto,
      user.accountId,
      user.sub,
      granted,
    );
  }

  // not gated by @RequirePermissions — anyone who can assign roles to a
  // colleague (users:manage_roles) or grant one at invite time (users:write)
  // needs to be able to list what's available, and those don't imply
  // roles:read. Same precedent as GET /permissions: reading the role list
  // isn't itself sensitive, only creating/editing/deleting one is.
  @AuthenticatedOnly()
  @Get()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: [RoleDetail] })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.rolesService.findAll(user.accountId);
  }

  @AuthenticatedOnly()
  @Get(':id')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: RoleDetail })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const role = await this.rolesService.findOne(+id, user.accountId);
    if (!role) throw new NotFoundException();
    return role;
  }

  @Patch(':id')
  @RequirePermissions('roles:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: RoleDetail })
  async update(
    @Param('id') id: string,
    @Body() updateRoleDto: UpdateRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @GrantedPermissions() granted: Set<string> | undefined,
  ) {
    const role = await this.rolesService.update(
      +id,
      updateRoleDto,
      user.accountId,
      user.sub,
      granted,
    );
    if (!role) throw new NotFoundException();
    return role;
  }

  @Delete(':id')
  @RequirePermissions('roles:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Role })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const role = await this.rolesService.remove(+id, user.accountId);
    if (!role) throw new NotFoundException();
    return role;
  }
}
