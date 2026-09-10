import {
  Controller,
  DefaultValuePipe,
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
import { CreateUserDto } from './dto/create-user.dto';
import { AssignRolesDto } from './dto/assign-roles.dto';
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
  constructor(private readonly usersService: UsersService) {}

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
}
