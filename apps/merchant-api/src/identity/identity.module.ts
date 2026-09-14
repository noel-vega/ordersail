import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { PermissionsModule } from './permissions/permissions.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { AccountModule } from './account/account.module';

// Identity & access: authentication, the user/role/permission model, tenant
// API keys, and account settings. Every other context depends on this (its
// guards run globally; see auth.module).
@Module({
  imports: [
    AuthModule,
    UsersModule,
    RolesModule,
    PermissionsModule,
    ApiKeysModule,
    AccountModule,
  ],
})
export class IdentityModule {}
