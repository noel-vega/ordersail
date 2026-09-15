import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../database/database.constants';
import { resolvePageParams } from '../../shared/pagination';
import {
  and,
  asc,
  categoriesTable,
  eq,
  productCategoriesTable,
  productsTable,
  sql,
  type db as Db,
} from 'db';
import { ListCategoriesQueryDto } from './dto/list-categories-query.dto';
import { PaginatedCategories } from './entities/paginated-categories.entity';

@Injectable()
export class CategoriesService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async findAll(
    { limit, offset }: ListCategoriesQueryDto,
    accountId: number,
  ): Promise<PaginatedCategories> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = eq(categoriesTable.accountId, accountId);

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: categoriesTable.id,
          name: categoriesTable.name,
          // draft/archived products never surface through the storefront,
          // so the second leftJoin's status filter keeps them out of the count
          productCount: sql<number>`coalesce(count(${productsTable.id}), 0)::int`,
        })
        .from(categoriesTable)
        .leftJoin(
          productCategoriesTable,
          eq(productCategoriesTable.categoryId, categoriesTable.id),
        )
        .leftJoin(
          productsTable,
          and(
            eq(productsTable.id, productCategoriesTable.productId),
            eq(productsTable.status, 'active'),
          ),
        )
        .where(where)
        .groupBy(categoriesTable.id)
        .orderBy(asc(categoriesTable.name), asc(categoriesTable.id))
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(categoriesTable)
        .where(where),
    ]);

    return { items, total, limit: take, offset: skip };
  }

  async findOne(
    id: number,
    accountId: number,
  ): Promise<{ id: number; name: string } | undefined> {
    const [category] = await this.db
      .select({ id: categoriesTable.id, name: categoriesTable.name })
      .from(categoriesTable)
      .where(
        and(
          eq(categoriesTable.id, id),
          eq(categoriesTable.accountId, accountId),
        ),
      );
    return category;
  }
}
