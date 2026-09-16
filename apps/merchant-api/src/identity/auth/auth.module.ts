import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { UsersModule } from '../users/users.module';
import { RolesModule } from '../roles/roles.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { jwtConstants } from './auth.constants';
import { AUTH_APP_GUARD } from './auth.guard';
import { EMAIL_VERIFIED_APP_GUARD } from './email-verified.guard';
import { PERMISSIONS_APP_GUARD } from './permissions.guard';
import { THROTTLER_APP_GUARD } from './throttler.guard';

@Module({
  imports: [
    UsersModule,
    RolesModule,
    PermissionsModule,
    // single 'default' bucket, 100 req/min/IP — merchant-api runs one ECS
    // task today (desired_count=1), so the built-in in-memory storage is
    // enough; revisit with a shared Redis store (ElastiCache is already
    // provisioned, see packages/queue's createRedisConnection) if/when
    // replica count goes above 1.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    JwtModule.register({
      global: true,
      secret: jwtConstants.secret,
      signOptions: {
        expiresIn: '60s',
      },
    }),
  ],
  // order matters: ThrottlerGuard runs first so a brute-force burst is
  // rejected before spending a JWT-verify cycle on it; AuthGuard must then
  // populate request.user before EmailVerifiedGuard/PermissionsGuard read
  // it. EmailVerifiedGuard runs before PermissionsGuard — an unverified
  // caller is blocked before permissions are even considered.
  providers: [
    THROTTLER_APP_GUARD,
    AUTH_APP_GUARD,
    EMAIL_VERIFIED_APP_GUARD,
    PERMISSIONS_APP_GUARD,
    AuthService,
  ],
  controllers: [AuthController],
})
export class AuthModule {}
