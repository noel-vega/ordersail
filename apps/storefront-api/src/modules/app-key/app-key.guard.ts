import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Provider,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { env } from '../../env';
import { DRIZZLE } from '../../database/database.constants';
import {
  accountApiKeysTable,
  and,
  eq,
  isNull,
  storefrontOriginsTable,
  type db as Db,
} from 'db';
import { IS_PUBLIC_KEY } from './app-key.decorators';
import { isLocalDevOrigin, normalizeOrigin } from './app-key.util';

const APP_KEY_HEADER = 'x-app-key';

@Injectable()
export class AppKeyGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const appKey = request.headers[APP_KEY_HEADER];
    if (!appKey || Array.isArray(appKey)) {
      throw new UnauthorizedException();
    }

    const [record] = await this.db
      .select()
      .from(accountApiKeysTable)
      .where(
        and(
          eq(accountApiKeysTable.key, appKey),
          isNull(accountApiKeysTable.revokedAt),
        ),
      );

    if (!record) {
      throw new UnauthorizedException();
    }

    // CORS itself is permissive (main.ts reflects any Origin) — a preflight
    // never carries x-app-key, so it can't tell which account this origin
    // needs to belong to. This is the real tenant-scoping check: the origin
    // must be registered to *this* app-key's account, not just registered by
    // someone (OS-448). No Origin header at all means a non-browser caller
    // (server-to-server, curl, health checks) — nothing to scope.
    const origin = request.headers.origin;
    if (origin) {
      const normalized = normalizeOrigin(origin);
      if (!isLocalDevOrigin(normalized ?? '', env.NODE_ENV)) {
        const [registered] = normalized
          ? await this.db
              .select({ id: storefrontOriginsTable.id })
              .from(storefrontOriginsTable)
              .where(
                and(
                  eq(storefrontOriginsTable.accountId, record.accountId),
                  eq(storefrontOriginsTable.origin, normalized),
                ),
              )
          : [];
        if (!registered) {
          throw new UnauthorizedException();
        }
      }
    }

    // stashed for CurrentAccountId() and for services to scope queries by tenant
    (request as Request & { accountId: number }).accountId = record.accountId;
    return true;
  }
}

export const APP_KEY_APP_GUARD: Provider = {
  provide: APP_GUARD,
  useClass: AppKeyGuard,
};
