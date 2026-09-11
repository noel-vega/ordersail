import { Inject, Injectable } from '@nestjs/common';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { resolvePageParams } from 'src/shared/pagination';
import {
  and,
  asc,
  categoriesTable,
  type db as Db,
  eq,
  ilike,
  productCategoriesTable,
  type SQL,
  sql,
} from 'db/catalog';
import { PaginatedCategories } from './entities/paginated-categories.entity';

@Injectable()
export class CategoriesService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async create(createCategoryDto: CreateCategoryDto, accountId: number) {
    const [category] = await this.db
      .insert(categoriesTable)
      .values({ name: createCategoryDto.name, accountId })
      .returning();
    return category;
  }

  async findAll(
    limit: number,
    offset: number,
    accountId: number,
    q?: string,
  ): Promise<PaginatedCategories> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = this.listFilter(accountId, q);

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: categoriesTable.id,
          accountId: categoriesTable.accountId,
          name: categoriesTable.name,
          createdAt: categoriesTable.createdAt,
          updatedAt: categoriesTable.updatedAt,
          // surfaced so the delete confirm dialog can warn "used by N
          // products" — categoryId cascades silently, nothing else guards it
          productCount: sql<number>`coalesce(count(${productCategoriesTable.productId}), 0)::int`,
        })
        .from(categoriesTable)
        .leftJoin(
          productCategoriesTable,
          eq(productCategoriesTable.categoryId, categoriesTable.id),
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

  async update(
    id: number,
    updateCategoryDto: UpdateCategoryDto,
    accountId: number,
  ) {
    const [category] = await this.db
      .update(categoriesTable)
      .set({ ...updateCategoryDto, updatedAt: new Date() })
      .where(
        and(
          eq(categoriesTable.id, id),
          eq(categoriesTable.accountId, accountId),
        ),
      )
      .returning();
    return category;
  }

  // unlike brands, nothing blocks this: product_categories.categoryId
  // cascades on delete, so removing a category just silently unlinks it from
  // any products that had it — the "used by N products" warning (findAll's
  // productCount) is surfaced before the merchant confirms, not enforced here
  async remove(id: number, accountId: number) {
    const [category] = await this.db
      .delete(categoriesTable)
      .where(
        and(
          eq(categoriesTable.id, id),
          eq(categoriesTable.accountId, accountId),
        ),
      )
      .returning();
    return category;
  }

  private listFilter(accountId: number, q?: string): SQL | undefined {
    const scope = eq(categoriesTable.accountId, accountId);
    const term = q?.trim();
    return term ? and(scope, ilike(categoriesTable.name, `%${term}%`)) : scope;
  }
}
