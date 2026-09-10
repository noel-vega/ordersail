import { Inject, Injectable } from '@nestjs/common';
import { CreateBrandDto } from './dto/create-brand.dto';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { resolvePageParams } from 'src/shared/pagination';
import {
  and,
  asc,
  brandsTable,
  type db as Db,
  eq,
  ilike,
  type SQL,
  sql,
} from 'db/catalog';
import { PaginatedBrands } from './entities/paginated-brands.entity';

@Injectable()
export class BrandsService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async create(createBrandDto: CreateBrandDto, accountId: number) {
    const [brand] = await this.db
      .insert(brandsTable)
      .values({ name: createBrandDto.name, accountId })
      .returning();
    return brand;
  }

  async findAll(
    limit: number,
    offset: number,
    accountId: number,
    q?: string,
  ): Promise<PaginatedBrands> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = this.listFilter(accountId, q);

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(brandsTable)
        .where(where)
        .orderBy(asc(brandsTable.name), asc(brandsTable.id))
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(brandsTable)
        .where(where),
    ]);

    return { items, total, limit: take, offset: skip };
  }

  private listFilter(accountId: number, q?: string): SQL | undefined {
    const scope = eq(brandsTable.accountId, accountId);
    const term = q?.trim();
    return term ? and(scope, ilike(brandsTable.name, `%${term}%`)) : scope;
  }
}
