import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../database/database.constants';
import { resolvePageParams } from '../../shared/pagination';
import {
  and,
  asc,
  brandsTable,
  eq,
  productsTable,
  sql,
  type db as Db,
} from 'db';
import { ListBrandsQueryDto } from './dto/list-brands-query.dto';
import { PaginatedBrands } from './entities/paginated-brands.entity';

@Injectable()
export class BrandsService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async findAll(
    { limit, offset }: ListBrandsQueryDto,
    accountId: number,
  ): Promise<PaginatedBrands> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = eq(brandsTable.accountId, accountId);

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: brandsTable.id,
          name: brandsTable.name,
          // draft/archived products never surface through the storefront,
          // so the join's status filter keeps them out of the count
          productCount: sql<number>`coalesce(count(${productsTable.id}), 0)::int`,
        })
        .from(brandsTable)
        .leftJoin(
          productsTable,
          and(
            eq(productsTable.brandId, brandsTable.id),
            eq(productsTable.status, 'active'),
          ),
        )
        .where(where)
        .groupBy(brandsTable.id)
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

  async findOne(
    id: number,
    accountId: number,
  ): Promise<{ id: number; name: string } | undefined> {
    const [brand] = await this.db
      .select({ id: brandsTable.id, name: brandsTable.name })
      .from(brandsTable)
      .where(and(eq(brandsTable.id, id), eq(brandsTable.accountId, accountId)));
    return brand;
  }
}
