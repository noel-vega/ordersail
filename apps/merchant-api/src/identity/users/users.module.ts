import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PermissionsModule } from '../permissions/permissions.module';
import { SessionsModule } from '../auth/sessions.module';

@Module({
  // SessionsModule, not AuthModule: deactivating a User ends their Sessions,
  // and AuthModule imports this module — importing it back would be a cycle.
  imports: [PermissionsModule, SessionsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
