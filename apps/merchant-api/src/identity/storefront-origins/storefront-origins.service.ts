import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  and,
  type db as Db,
  eq,
  isUniqueViolation,
  storefrontOriginsTable,
} from 'db/identity';
import { normalizeOrigin } from './storefront-origins.util';

const STOREFRONT_ORIGIN_COLUMNS = {
  id: storefrontOriginsTable.id,
  origin: storefrontOriginsTable.origin,
  createdAt: storefrontOriginsTable.createdAt,
} as const;

@Injectable()
export class StorefrontOriginsService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async listForAccount(accountId: number) {
    return this.db
      .select(STOREFRONT_ORIGIN_COLUMNS)
      .from(storefrontOriginsTable)
      .where(eq(storefrontOriginsTable.accountId, accountId));
  }

  async createForAccount(accountId: number, rawOrigin: string) {
    const origin = normalizeOrigin(rawOrigin);
    if (!origin) {
      throw new BadRequestException(
        'origin must be a bare http(s) origin, e.g. https://shop.example.com',
      );
    }

    try {
      const [created] = await this.db
        .insert(storefrontOriginsTable)
        .values({ accountId, origin })
        .returning(STOREFRONT_ORIGIN_COLUMNS);
      return created;
    } catch (err) {
      // unique(accountId, origin) — a merchant re-registering the same
      // origin is a no-op mistake, not a server error
      if (isUniqueViolation(err)) {
        throw new ConflictException('This origin is already registered');
      }
      throw err;
    }
  }

  // scoped to the account so a cross-account or missing id returns nothing
  // (→ 404 at the controller)
  async deleteForAccount(id: number, accountId: number) {
    const [deleted] = await this.db
      .delete(storefrontOriginsTable)
      .where(
        and(
          eq(storefrontOriginsTable.id, id),
          eq(storefrontOriginsTable.accountId, accountId),
        ),
      )
      .returning(STOREFRONT_ORIGIN_COLUMNS);

    return deleted ?? null;
  }
}
