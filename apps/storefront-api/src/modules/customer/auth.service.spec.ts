import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { customerRefreshTokensTable, eq } from 'db';
import { insertAccount, insertCustomer, useTestDb } from 'test-support';
import { AuthService } from './auth.service';
import type { AuthenticatedCustomer } from './auth.decorators';
import type { CartService } from '../cart/cart.service';
import type { EmailService } from '../email/email.service';
import type { CustomerService } from './customer.service';

const db = useTestDb();
const jwtService = new JwtService({ secret: 'test-secret' });

function build() {
  return new AuthService(
    db,
    jwtService,
    {} as unknown as CustomerService,
    {} as unknown as CartService,
    {} as unknown as EmailService,
  );
}

async function seed() {
  const account = await insertAccount(db);
  const customer = await insertCustomer(db, { accountId: account.id });
  return customer;
}

describe('AuthService refresh-token rotation (OS-457)', () => {
  it('createRefreshToken inserts a row and signs a token carrying its jti', async () => {
    const customer = await seed();
    const service = build();

    const token = await service.createRefreshToken(
      customer.id,
      customer.email,
      customer.accountId,
      customer.firstname,
      customer.lastname,
      'family-1',
    );
    const payload = await jwtService.verifyAsync<AuthenticatedCustomer>(token);

    expect(payload.typ).toBe('refresh');
    expect(payload.jti).toEqual(expect.any(String));

    const [row] = await db
      .select()
      .from(customerRefreshTokensTable)
      .where(eq(customerRefreshTokensTable.jti, payload.jti!));
    expect(row).toMatchObject({
      customerId: customer.id,
      familyId: 'family-1',
      revokedAt: null,
    });
  });

  it('rotates on use: returns a new pair and revokes the presented token', async () => {
    const customer = await seed();
    const service = build();
    const oldToken = await service.createRefreshToken(
      customer.id,
      customer.email,
      customer.accountId,
      customer.firstname,
      customer.lastname,
      'family-2',
    );
    const oldPayload =
      await jwtService.verifyAsync<AuthenticatedCustomer>(oldToken);

    const result = await service.refreshTokens(oldToken);

    expect(result.access_token).toEqual(expect.any(String));
    expect(result.refresh_token).toEqual(expect.any(String));

    const [oldRow] = await db
      .select()
      .from(customerRefreshTokensTable)
      .where(eq(customerRefreshTokensTable.jti, oldPayload.jti!));
    expect(oldRow.revokedAt).not.toBeNull();

    const newPayload = await jwtService.verifyAsync<AuthenticatedCustomer>(
      result.refresh_token,
    );
    expect(newPayload.jti).not.toBe(oldPayload.jti);
    const [newRow] = await db
      .select()
      .from(customerRefreshTokensTable)
      .where(eq(customerRefreshTokensTable.jti, newPayload.jti!));
    expect(newRow).toMatchObject({ familyId: 'family-2', revokedAt: null });
  });

  // the core hardening: two redemptions of the same token means one of them
  // is illegitimate — since we can't tell which, kill the whole chain
  it('reuse of an already-rotated-out token revokes the whole family', async () => {
    const customer = await seed();
    const service = build();
    const token1 = await service.createRefreshToken(
      customer.id,
      customer.email,
      customer.accountId,
      customer.firstname,
      customer.lastname,
      'family-3',
    );

    const { refresh_token: token2 } = await service.refreshTokens(token1);

    // token1 was already redeemed above — presenting it again is reuse
    await expect(service.refreshTokens(token1)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    // the whole family, including the just-issued token2, must now be dead
    await expect(service.refreshTokens(token2)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a well-formed but unknown jti', async () => {
    const customer = await seed();
    const service = build();
    const forged = await jwtService.signAsync({
      sub: customer.id,
      email: customer.email,
      accountId: customer.accountId,
      firstName: customer.firstname,
      lastName: customer.lastname,
      typ: 'refresh',
      jti: 'nonexistent-jti',
    });

    await expect(service.refreshTokens(forged)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an access token presented as a refresh token', async () => {
    const customer = await seed();
    const service = build();
    const accessToken = await service.createAccessToken(
      customer.id,
      customer.email,
      customer.accountId,
      customer.firstname,
      customer.lastname,
    );

    await expect(service.refreshTokens(accessToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an invalid or malformed token', async () => {
    const service = build();

    await expect(service.refreshTokens('not-a-jwt')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
