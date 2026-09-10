import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  accountApiKeysTable,
  and,
  type db as Db,
  eq,
  isNull,
} from 'db/identity';
import { generateApiKey } from './api-keys.util';

// the four columns the merchant ever sees — the same projection for list and
// create so the SDK/DTO shape stays identical
const API_KEY_COLUMNS = {
  id: accountApiKeysTable.id,
  key: accountApiKeysTable.key,
  label: accountApiKeysTable.label,
  createdAt: accountApiKeysTable.createdAt,
} as const;

@Injectable()
export class ApiKeysService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async listForAccount(accountId: number) {
    return this.db
      .select(API_KEY_COLUMNS)
      .from(accountApiKeysTable)
      .where(
        and(
          eq(accountApiKeysTable.accountId, accountId),
          isNull(accountApiKeysTable.revokedAt),
        ),
      );
  }

  async createForAccount(accountId: number, label?: string | null) {
    const [created] = await this.db
      .insert(accountApiKeysTable)
      .values({ accountId, key: generateApiKey(), label: label ?? null })
      .returning(API_KEY_COLUMNS);

    return created;
  }
}
