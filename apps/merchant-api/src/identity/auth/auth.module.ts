import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SessionsModule } from './sessions.module';
import { AuthController } from './auth.controller';
import { PasskeysController } from './passkeys.controller';
import { PasskeysService } from './passkeys.service';
import { ThrottlerModule } from '@nestjs/throttler';
import { UsersModule } from '../users/users.module';
import { AccountModule } from '../account/account.module';
import { EmailedLinksModule } from '../emailed-links/emailed-links.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AUTH_APP_GUARD } from './auth.guard';
import { EMAIL_VERIFIED_APP_GUARD } from './email-verified.guard';
import { MFA_ENROLLMENT_APP_GUARD } from './mfa-enrollment.guard';
import { PERMISSIONS_APP_GUARD } from './permissions.guard';
import { MFA_FACTOR_APP_GUARD } from './mfa-factor.guard';
import { THROTTLER_APP_GUARD } from './throttler.guard';

@Module({
  imports: [
    // Sessions + FactorStateService, and the global JWT registration — a
    // module of its own so UsersModule can import it too (see there).
    SessionsModule,
    UsersModule,
    AccountModule,
    PermissionsModule,
    // Every link this module sends or redeems goes through it: password
    // reset, email verification, and the Invite's redemption. Issuing an
    // Invite is UsersModule's, which imports it too.
    EmailedLinksModule,
    // single 'default' bucket, 100 req/min/IP — merchant-api runs one ECS
    // task today (desired_count=1), so the built-in in-memory storage is
    // enough; revisit with a shared Redis store (ElastiCache is already
    // provisioned, see packages/queue's createRedisConnection) if/when
    // replica count goes above 1.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
  ],
  // order matters: ThrottlerGuard runs first so a brute-force burst is
  // rejected before spending a JWT-verify cycle on it; AuthGuard must then
  // populate request.user before EmailVerifiedGuard/MfaEnrollmentGuard/
  // PermissionsGuard read it. EmailVerifiedGuard runs before
  // MfaEnrollmentGuard (enrolling MFA requires a verified email, OS-473),
  // and both run before PermissionsGuard — an unverified or unenrolled
  // caller is blocked before permissions are even considered.
  providers: [
    THROTTLER_APP_GUARD,
    AUTH_APP_GUARD,
    EMAIL_VERIFIED_APP_GUARD,
    MFA_ENROLLMENT_APP_GUARD,
    PERMISSIONS_APP_GUARD,
    // Last, deliberately: someone who lacks the permission entirely should
    // be told that, not asked to add a passkey for an action they could
    // never perform anyway.
    MFA_FACTOR_APP_GUARD,
    AuthService,
    PasskeysService,
  ],
  controllers: [AuthController, PasskeysController],
})
export class AuthModule {}
