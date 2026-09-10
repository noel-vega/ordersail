import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { insertAccount, insertApiKey, useTestDb } from 'test-support';
import { AppKeyGuard } from './app-key.guard';

const db = useTestDb();

// AppKeyGuard only ever reads `context.getHandler()` / `getClass()` (passed
// straight to the reflector stub) and the request headers.
function contextWithHeaders(headers: Record<string, string | string[]>): {
  ctx: ExecutionContext;
  request: { headers: typeof headers; accountId?: number };
} {
  const request = { headers };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, request };
}

function build(isPublic = false) {
  const reflector = {
    getAllAndOverride: () => isPublic,
  } as unknown as Reflector;
  return new AppKeyGuard(db, reflector);
}

describe('AppKeyGuard (OS-170)', () => {
  it('allows an active key and stashes the account id', async () => {
    const account = await insertAccount(db);
    const key = await insertApiKey(db, { accountId: account.id });
    const guard = build();
    const { ctx, request } = contextWithHeaders({ 'x-app-key': key.key });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.accountId).toBe(account.id);
  });

  it('rejects a revoked key', async () => {
    const account = await insertAccount(db);
    const key = await insertApiKey(db, {
      accountId: account.id,
      revokedAt: new Date(),
    });
    const guard = build();
    const { ctx } = contextWithHeaders({ 'x-app-key': key.key });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a missing header', async () => {
    const guard = build();
    const { ctx } = contextWithHeaders({});

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('lets a @Public() route through without a key', async () => {
    const guard = build(true);
    const { ctx } = contextWithHeaders({});

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
