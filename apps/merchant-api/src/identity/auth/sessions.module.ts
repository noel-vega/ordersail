import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from './auth.constants';
import { FactorStateService } from './factor-state.service';
import { SessionsService } from './sessions.service';

// Sessions in a Nest module of its own, below both of its callers: AuthModule
// (every sign-in operation starts a Session) and UsersModule (deactivating a
// User ends all of theirs). AuthModule imports UsersModule, so a
// SessionsService provided by AuthModule could only reach UsersService
// through a module cycle. What keeps this a leaf is that Sessions depends on
// the database, the JWT config and FactorStateService — never on
// UsersService or AuthService. Keep it that way.
//
// FactorStateService lives here because Sessions computes the Factor claims
// itself; it is exported for AuthService, PasskeysService and MfaFactorGuard.
//
// The JWT registration moved here with the service that signs. It stays
// `global`, which is what hands JwtService to AuthGuard (an APP_GUARD) and
// to the MFA challenge tokens AuthService signs.
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: jwtConstants.secret,
      signOptions: {
        expiresIn: '60s',
      },
    }),
  ],
  providers: [SessionsService, FactorStateService],
  exports: [SessionsService, FactorStateService],
})
export class SessionsModule {}
