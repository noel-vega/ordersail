import { Inject, Injectable } from '@nestjs/common';
import { CreateCategoryDto } from './dto/create-category.dto';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { resolvePageParams } from 'src/shared/pagination';
import {
  and,
  asc,
  categoriesTable,
  type db as Db,
  eq,
  ilike,
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
        .select()
        .from(categoriesTable)
        .where(where)
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

  private listFilter(accountId: number, q?: string): SQL | undefined {
    const scope = eq(categoriesTable.accountId, accountId);
    const term = q?.trim();
    return term ? and(scope, ilike(categoriesTable.name, `%${term}%`)) : scope;
  }
}
