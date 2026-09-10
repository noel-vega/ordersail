import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SignInDto } from './dto/signin.dto';
import { SignUpDto } from './dto/signup.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { UsersService } from '../users/users.service';
import { RolesService } from '../roles/roles.service';
import { PermissionsService } from '../permissions/permissions.service';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { type AuthenticatedUser } from 'src/shared/auth/decorators';
import { AuthMe } from './entities/auth-me.entity';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  accountApiKeysTable,
  accountsTable,
  type db as Db,
  isUniqueViolation,
  usersTable,
} from 'db/identity';
import { locationsTable } from 'db/stock';
import * as bcrypt from 'bcryptjs';
import { generateApiKey } from '../api-keys/api-keys.util';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private jwtService: JwtService,
    private usersService: UsersService,
    private rolesService: RolesService,
    private permissionsService: PermissionsService,
  ) {}

  async me(user: AuthenticatedUser): Promise<AuthMe> {
    const permissions =
      await this.permissionsService.getEffectivePermissionKeys(user.sub);
    return {
      userId: user.sub,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      accountId: user.accountId,
      permissions: [...permissions].sort(),
    };
  }

  async signin(signinDto: SignInDto) {
    const user = await this.usersService.getByEmail(signinDto.email);

    // staff created from the dashboard have no password until they join via
    // an invite link — treat that the same as a wrong password, not a crash
    if (!user || !user.password) {
      throw new UnauthorizedException();
    }

    if (!(await bcrypt.compare(signinDto.password, user.password))) {
      throw new UnauthorizedException();
    }

    const access_token = await this.createAccessToken(
      user.id,
      user.email,
      user.accountId,
      user.firstname,
      user.lastname,
    );

    return {
      userId: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstname,
      lastName: user.lastname,
      access_token,
    };
  }

  async signup(signupDto: SignUpDto) {
    try {
      const user = await this.db.transaction(async (tx) => {
        const [account] = await tx
          .insert(accountsTable)
          .values({
            name: signupDto.businessName,
            phone: signupDto.phone,
            email: signupDto.email,
          })
          .returning();

        await tx.insert(accountApiKeysTable).values({
          accountId: account.id,
          key: generateApiKey(),
        });

        // products need somewhere to hold stock — every account starts
        // with a single seeded location, see locationsTable
        await tx.insert(locationsTable).values({
          accountId: account.id,
          name: 'Default',
        });

        const hashedPassword = await bcrypt.hash(signupDto.password, 10);

        const [user] = await tx
          .insert(usersTable)
          .values({
            firstname: signupDto.firstName,
            lastname: signupDto.lastName,
            email: signupDto.email,
            password: hashedPassword,
            accountId: account.id,
          })
          .returning();

        // every account starts with a non-deletable "Owner" role holding
        // every permission, assigned to the account's first user
        await this.rolesService.createSystemRole(tx, account.id, user.id);

        return user;
      });

      const access_token = await this.createAccessToken(
        user.id,
        user.email,
        user.accountId,
        user.firstname,
        user.lastname,
      );

      return {
        userId: user.id,
        email: user.email,
        accountId: user.accountId,
        firstName: user.firstname,
        lastName: user.lastname,
        access_token,
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Email already in use');
      }
      throw err;
    }
  }

  async acceptInvite(dto: AcceptInviteDto) {
    const invite = await this.usersService.getByInviteToken(dto.token);

    if (!invite || invite.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired invite');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.usersService.activate(
      invite.user.id,
      hashedPassword,
    );

    if (!user) {
      throw new UnauthorizedException('Invalid or expired invite');
    }

    const access_token = await this.createAccessToken(
      user.id,
      user.email,
      user.accountId,
      user.firstName,
      user.lastName,
    );

    return {
      userId: user.id,
      email: user.email,
      accountId: user.accountId,
      firstName: user.firstName,
      lastName: user.lastName,
      access_token,
    };
  }

  private async createToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
    expiresIn: JwtSignOptions['expiresIn'],
  ) {
    const payload = { sub, email, accountId, firstName, lastName };
    const token = await this.jwtService.signAsync(payload, {
      expiresIn,
    });
    return token;
  }

  async createAccessToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
  ) {
    return await this.createToken(
      sub,
      email,
      accountId,
      firstName,
      lastName,
      '8h',
    );
  }

  async createRefreshToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
  ) {
    return await this.createToken(
      sub,
      email,
      accountId,
      firstName,
      lastName,
      '7d',
    );
  }

  async refreshAccessToken(refreshToken: string) {
    try {
      // Returns the decoded payload if valid
      const payload =
        await this.jwtService.verifyAsync<AuthenticatedUser>(refreshToken);
      const token = await this.createAccessToken(
        payload.sub,
        payload.email,
        payload.accountId,
        payload.firstName,
        payload.lastName,
      );
      return token;
    } catch {
      // Throws error if token is expired, tampered, or invalid
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
