import { Inject, Injectable } from '@nestjs/common';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { resolvePageParams } from 'src/shared/pagination';
import {
  and,
  asc,
  type db as Db,
  eq,
  ilike,
  locationsTable,
  type SQL,
  sql,
} from 'db/stock';
import { PaginatedLocations } from './entities/paginated-locations.entity';

@Injectable()
export class LocationsService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async create(createLocationDto: CreateLocationDto, accountId: number) {
    const [location] = await this.db
      .insert(locationsTable)
      .values({ name: createLocationDto.name, accountId })
      .returning();
    return location;
  }

  async findAll(
    limit: number,
    offset: number,
    accountId: number,
    q?: string,
  ): Promise<PaginatedLocations> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = this.listFilter(accountId, q);

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(locationsTable)
        .where(where)
        .orderBy(asc(locationsTable.name), asc(locationsTable.id))
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(locationsTable)
        .where(where),
    ]);

    return { items, total, limit: take, offset: skip };
  }

  private listFilter(accountId: number, q?: string): SQL | undefined {
    const scope = eq(locationsTable.accountId, accountId);
    const term = q?.trim();
    return term ? and(scope, ilike(locationsTable.name, `%${term}%`)) : scope;
  }

  async update(
    id: number,
    updateLocationDto: UpdateLocationDto,
    accountId: number,
  ) {
    const [location] = await this.db
      .update(locationsTable)
      .set({ ...updateLocationDto, updatedAt: new Date() })
      .where(
        and(eq(locationsTable.id, id), eq(locationsTable.accountId, accountId)),
      )
      .returning();
    return location;
  }
}
