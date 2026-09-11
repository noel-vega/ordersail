import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { resolvePageParams } from 'src/shared/pagination';
import {
  and,
  asc,
  brandsTable,
  type db as Db,
  eq,
  ilike,
  productsTable,
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

  async update(id: number, updateBrandDto: UpdateBrandDto, accountId: number) {
    const [brand] = await this.db
      .update(brandsTable)
      .set({ ...updateBrandDto, updatedAt: new Date() })
      .where(and(eq(brandsTable.id, id), eq(brandsTable.accountId, accountId)))
      .returning();
    return brand;
  }

  // the brand row is locked FOR UPDATE for the whole transaction — Postgres
  // already takes an implicit FOR KEY SHARE lock on a referenced row
  // whenever a referencing row is inserted (exactly what a concurrent
  // product create/update does to products.brandId), so this serializes
  // against that insert instead of racing the in-use check against it.
  // brandId has no onDelete behavior, so an unguarded delete would surface as
  // a raw 23503 — precheck instead for a clean error (mirrors
  // roles.service.ts remove()).
  async remove(id: number, accountId: number) {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(brandsTable)
        .where(
          and(eq(brandsTable.id, id), eq(brandsTable.accountId, accountId)),
        )
        .for('update');

      if (!existing) return undefined;

      const [inUse] = await tx
        .select({ id: productsTable.id })
        .from(productsTable)
        .where(eq(productsTable.brandId, id))
        .limit(1);

      if (inUse) {
        throw new ConflictException(
          'This brand is still assigned to products — remove it from them before deleting.',
        );
      }

      const [brand] = await tx
        .delete(brandsTable)
        .where(
          and(eq(brandsTable.id, id), eq(brandsTable.accountId, accountId)),
        )
        .returning();

      return brand;
    });
  }

  private listFilter(accountId: number, q?: string): SQL | undefined {
    const scope = eq(brandsTable.accountId, accountId);
    const term = q?.trim();
    return term ? and(scope, ilike(brandsTable.name, `%${term}%`)) : scope;
  }
}
