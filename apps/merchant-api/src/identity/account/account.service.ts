import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { accountsTable, type db as Db, eq } from 'db/identity';
import { UpdateAccountDto } from './dto/update-account.dto';

@Injectable()
export class AccountService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async findOne(accountId: number) {
    const [account] = await this.db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, accountId));
    if (!account) throw new NotFoundException();
    return account;
  }

  async update(accountId: number, dto: UpdateAccountDto) {
    const { requireMfa, ...rest } = dto;
    const [account] = await this.db
      .update(accountsTable)
      .set({
        ...rest,
        // undefined -> omitted from the update, leaving the column as-is
        ...(requireMfa !== undefined && {
          requireMfaAt: requireMfa ? new Date() : null,
        }),
        updatedAt: new Date(),
      })
      .where(eq(accountsTable.id, accountId))
      .returning();
    if (!account) throw new NotFoundException();
    return account;
  }
}
