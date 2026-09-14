import { randomUUID } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { type AuthenticatedCustomer } from './auth.decorators';
import { CustomerSignUpDto } from './dto/customer-signup.dto';
import { CustomerSignInDto } from './dto/customer-signin.dto';
import { CustomerService } from './customer.service';
import { CartService } from '../cart/cart.service';
import { EmailService } from '../email/email.service';
import { DRIZZLE } from '../../database/database.constants';
import { env } from '../../env';
import {
  accountsTable,
  and,
  customerRefreshTokensTable,
  eq,
  isNull,
  type db as Db,
} from 'db';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private jwtService: JwtService,
    private customerService: CustomerService,
    private cartService: CartService,
    private emailService: EmailService,
  ) {}

  async signup(dto: CustomerSignUpDto, accountId: number) {
    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const customer = await this.customerService.create(
      { firstName: dto.firstName, lastName: dto.lastName, email: dto.email },
      hashedPassword,
      accountId,
    );

    const [account] = await this.db
      .select({ name: accountsTable.name })
      .from(accountsTable)
      .where(eq(accountsTable.id, accountId));

    // sent on behalf of the shop, not "Ordersail" — see EmailService
    await this.emailService.sendThankYouEmail(customer.email, {
      firstName: customer.firstname,
      accountName: account.name,
    });

    const access_token = await this.createAccessToken(
      customer.id,
      customer.email,
      customer.accountId,
      customer.firstname,
      customer.lastname,
    );

    return {
      customerId: customer.id,
      email: customer.email,
      accountId: customer.accountId,
      firstName: customer.firstname,
      lastName: customer.lastname,
      access_token,
    };
  }

  async signin(
    dto: CustomerSignInDto,
    accountId: number,
    cartToken: string | undefined,
  ) {
    const customer = await this.customerService.getByEmail(
      accountId,
      dto.email,
    );

    if (!customer || !(await bcrypt.compare(dto.password, customer.password))) {
      throw new UnauthorizedException();
    }

    // carries the guest cart (if any) over to the account that just signed
    // in — last-guest-cart-wins, not a merge across multiple carts
    await this.cartService.claimCart(cartToken, customer.id, accountId);

    const access_token = await this.createAccessToken(
      customer.id,
      customer.email,
      customer.accountId,
      customer.firstname,
      customer.lastname,
    );

    return {
      customerId: customer.id,
      email: customer.email,
      accountId: customer.accountId,
      firstName: customer.firstname,
      lastName: customer.lastname,
      access_token,
    };
  }

  private async sign(
    payload: Record<string, unknown>,
    expiresIn: JwtSignOptions['expiresIn'],
  ) {
    return await this.jwtService.signAsync(payload, { expiresIn });
  }

  async createAccessToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
  ) {
    return await this.sign(
      { sub, email, accountId, firstName, lastName, typ: 'access' },
      '8h',
    );
  }

  // familyId is fresh (randomUUID()) for a brand-new session (signup/signin)
  // and carried through unchanged on every rotation (refreshTokens) — it's
  // the unit reuse detection revokes as a whole
  async createRefreshToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
    familyId: string,
  ) {
    const jti = randomUUID();
    await this.db
      .insert(customerRefreshTokensTable)
      .values({ customerId: sub, jti, familyId });

    return await this.sign(
      { sub, email, accountId, firstName, lastName, typ: 'refresh', jti },
      env.CUSTOMER_REFRESH_TOKEN_TTL as JwtSignOptions['expiresIn'],
    );
  }

  // Single-use: every call revokes the presented refresh token and issues a
  // fresh access+refresh pair in the same family. Presenting a token that's
  // already been rotated out is a theft signal — the legitimate holder and
  // an attacker holding a stolen copy can't both redeem the same token, so
  // whichever redeems second looks like reuse and kills the whole family,
  // forcing a real re-login rather than silently trusting either side.
  async refreshTokens(refreshToken: string) {
    let payload: AuthenticatedCustomer;
    try {
      payload =
        await this.jwtService.verifyAsync<AuthenticatedCustomer>(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload.typ !== 'refresh' || !payload.jti) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const [record] = await this.db
      .select()
      .from(customerRefreshTokensTable)
      .where(eq(customerRefreshTokensTable.jti, payload.jti));

    if (!record) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (record.revokedAt) {
      await this.db
        .update(customerRefreshTokensTable)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(customerRefreshTokensTable.familyId, record.familyId),
            isNull(customerRefreshTokensTable.revokedAt),
          ),
        );
      throw new UnauthorizedException('Invalid or expired token');
    }

    await this.db
      .update(customerRefreshTokensTable)
      .set({ revokedAt: new Date() })
      .where(eq(customerRefreshTokensTable.id, record.id));

    const access_token = await this.createAccessToken(
      payload.sub,
      payload.email,
      payload.accountId,
      payload.firstName,
      payload.lastName,
    );
    const refresh_token = await this.createRefreshToken(
      payload.sub,
      payload.email,
      payload.accountId,
      payload.firstName,
      payload.lastName,
      record.familyId,
    );

    return { access_token, refresh_token };
  }
}
