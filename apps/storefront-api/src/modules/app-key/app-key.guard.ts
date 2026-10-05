import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Provider,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ApiException } from 'errors';
import { DRIZZLE } from '../../database/database.constants';
import { accountApiKeysTable, and, eq, isNull, type db as Db } from 'db';
import { setLogContext } from 'logging';
import { IS_PUBLIC_KEY } from './app-key.decorators';

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

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const appKey = request.headers[APP_KEY_HEADER];
    if (!appKey || Array.isArray(appKey)) {
      throw new ApiException('invalid_app_key');
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
      throw new ApiException('invalid_app_key');
    }

    // stashed for CurrentAccountId() and for services to scope queries by tenant
    (request as FastifyRequest & { accountId: number }).accountId =
      record.accountId;
    setLogContext({ accountId: record.accountId, appKeyId: record.id });
    return true;
  }
}

export const APP_KEY_APP_GUARD: Provider = {
  provide: APP_GUARD,
  useClass: AppKeyGuard,
};
