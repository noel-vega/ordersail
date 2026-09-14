import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { type AuthenticatedCustomer } from './auth.decorators';
import { CustomerSignUpDto } from './dto/customer-signup.dto';
import { CustomerSignInDto } from './dto/customer-signin.dto';
import { CustomerService } from '../customer/customer.service';
import { CartService } from '../cart/cart.service';
import { EmailService } from '../email/email.service';
import { DRIZZLE } from '../../database/database.constants';
import { accountsTable, eq, type db as Db } from 'db';

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

  private async createToken(
    sub: number,
    email: string,
    accountId: number,
    firstName: string,
    lastName: string,
    expiresIn: JwtSignOptions['expiresIn'],
  ) {
    const payload = { sub, email, accountId, firstName, lastName };
    return await this.jwtService.signAsync(payload, { expiresIn });
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
      const payload =
        await this.jwtService.verifyAsync<AuthenticatedCustomer>(refreshToken);
      return await this.createAccessToken(
        payload.sub,
        payload.email,
        payload.accountId,
        payload.firstName,
        payload.lastName,
      );
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
