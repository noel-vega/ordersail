import { ConflictException, Inject, Injectable } from '@nestjs/common';
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
  inventoryMovementsTable,
  inventoryTable,
  isForeignKeyViolation,
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

  // the location row is locked FOR UPDATE for the whole transaction — same
  // reasoning as roles.service.ts remove(): Postgres already takes an
  // implicit FOR KEY SHARE lock on a referenced row whenever a referencing
  // row is inserted, so this serializes against that insert instead of
  // racing the in-use check against it.
  //
  // inventory + inventory_movements are this context's own tables and both
  // cascade on delete (no FK error would otherwise fire), so they're
  // precheck-guarded explicitly. pos_devices and fulfillments also
  // reference locationId (restrict) but live in other bounded contexts
  // (platform, sales) that src/stock isn't allowed to import directly — the
  // stock context's read-graph only reaches db/identity + db/catalog, not
  // db/sales or root db (see apps/merchant-api/ARCHITECTURE.md § Data
  // access). Those two are guarded by letting the DB's own restrict
  // constraint fire and converting the 23503 into a clean error instead.
  async remove(id: number, accountId: number) {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(locationsTable)
        .where(
          and(
            eq(locationsTable.id, id),
            eq(locationsTable.accountId, accountId),
          ),
        )
        .for('update');

      if (!existing) return undefined;

      const [hasInventory] = await tx
        .select({ id: inventoryTable.id })
        .from(inventoryTable)
        .where(eq(inventoryTable.locationId, id))
        .limit(1);

      if (hasInventory) {
        throw new ConflictException(
          'This location still has inventory — move stock before deleting it.',
        );
      }

      const [hasMovements] = await tx
        .select({ id: inventoryMovementsTable.id })
        .from(inventoryMovementsTable)
        .where(eq(inventoryMovementsTable.locationId, id))
        .limit(1);

      if (hasMovements) {
        throw new ConflictException(
          "This location has inventory movement history and can't be deleted.",
        );
      }

      try {
        const [location] = await tx
          .delete(locationsTable)
          .where(
            and(
              eq(locationsTable.id, id),
              eq(locationsTable.accountId, accountId),
            ),
          )
          .returning();

        return location;
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          throw new ConflictException(
            "This location still has a POS device paired or fulfillment history and can't be deleted.",
          );
        }
        throw err;
      }
    });
  }
}
