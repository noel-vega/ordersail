import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PermissionsModule } from '../permissions/permissions.module';
import { SessionsModule } from '../auth/sessions.module';
import { EmailedLinksModule } from '../emailed-links/emailed-links.module';

@Module({
  // SessionsModule, not AuthModule: deactivating a User ends their Sessions,
  // and AuthModule imports this module — importing it back would be a cycle.
  // EmailedLinksModule is a leaf, so it can be imported from both sides.
  imports: [PermissionsModule, SessionsModule, EmailedLinksModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
