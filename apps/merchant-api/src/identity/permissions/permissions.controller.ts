import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { AuthenticatedOnly } from 'src/shared/auth/decorators';
import { PermissionsService } from './permissions.service';
import { Permission } from './entities/permission.entity';

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  // any authenticated staffer can read the fixed catalog — needed to build
  // a role-editing UI, and the catalog itself grants nothing on its own
  @AuthenticatedOnly()
  @Get()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: [Permission] })
  findAll() {
    return this.permissionsService.findAll();
  }
}
