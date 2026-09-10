import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { resolvePageParams } from 'src/shared/pagination';
import { usersTable } from 'db/identity';
import { productsTable, productVariantsTable } from 'db/catalog';
import {
  and,
  asc,
  type db as Db,
  desc,
  eq,
  ilike,
  inventoryMovementReasonEnum,
  inventoryMovementsTable,
  inventoryTable,
  locationsTable,
  lte,
  or,
  type SQL,
  sql,
} from 'db/stock';
import { InventoryMovementRecord } from './entities/inventory.entity';
import {
  PaginatedInventory,
  PaginatedInventoryMovements,
} from './entities/paginated-inventory.entity';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';

type InventoryMovementReason =
  (typeof inventoryMovementReasonEnum.enumValues)[number];

export interface InventoryFilter {
  q?: string;
  productId?: number;
  locationId?: number;
  stockLte?: number;
}

export interface MovementFilter {
  variantId?: number;
  locationId?: number;
  reason?: InventoryMovementReason;
}

@Injectable()
export class InventoryService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async findAll(
    limit: number,
    offset: number,
    accountId: number,
    filter: InventoryFilter = {},
  ): Promise<PaginatedInventory> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = this.inventoryWhere(accountId, filter);

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: inventoryTable.id,
          variantId: inventoryTable.variantId,
          sku: productVariantsTable.sku,
          productId: productsTable.id,
          productName: productsTable.name,
          locationId: locationsTable.id,
          locationName: locationsTable.name,
          stock: inventoryTable.stock,
          updatedAt: inventoryTable.updatedAt,
        })
        .from(inventoryTable)
        .innerJoin(
          productVariantsTable,
          eq(productVariantsTable.id, inventoryTable.variantId),
        )
        .innerJoin(
          productsTable,
          eq(productsTable.id, productVariantsTable.productId),
        )
        .innerJoin(
          locationsTable,
          eq(locationsTable.id, inventoryTable.locationId),
        )
        .where(where)
        .orderBy(asc(productsTable.name), asc(inventoryTable.id))
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(inventoryTable)
        .innerJoin(
          productVariantsTable,
          eq(productVariantsTable.id, inventoryTable.variantId),
        )
        .innerJoin(
          productsTable,
          eq(productsTable.id, productVariantsTable.productId),
        )
        .where(where),
    ]);

    return { items, total, limit: take, offset: skip };
  }

  // insert a ledger entry and atomically fold its delta into the
  // materialized balance — the two never happen independently
  async createMovement(
    dto: CreateInventoryMovementDto,
    userId: number | undefined,
    accountId: number,
  ): Promise<InventoryMovementRecord> {
    const [variant] = await this.db
      .select({ id: productVariantsTable.id })
      .from(productVariantsTable)
      .innerJoin(
        productsTable,
        eq(productsTable.id, productVariantsTable.productId),
      )
      .where(
        and(
          eq(productVariantsTable.id, dto.variantId),
          eq(productsTable.accountId, accountId),
        ),
      );
    if (!variant) {
      throw new BadRequestException('Variant not found');
    }

    const [location] = await this.db
      .select({ id: locationsTable.id })
      .from(locationsTable)
      .where(
        and(
          eq(locationsTable.id, dto.locationId),
          eq(locationsTable.accountId, accountId),
        ),
      );
    if (!location) {
      throw new BadRequestException('Location not found');
    }

    const movementId = await this.db.transaction(async (tx) => {
      const [movement] = await tx
        .insert(inventoryMovementsTable)
        .values({
          variantId: dto.variantId,
          locationId: dto.locationId,
          delta: dto.delta,
          reason: dto.reason,
          note: dto.note ?? null,
          createdByUserId: userId ?? null,
        })
        .returning();

      await tx
        .insert(inventoryTable)
        .values({
          variantId: dto.variantId,
          locationId: dto.locationId,
          stock: dto.delta,
        })
        .onConflictDoUpdate({
          target: [inventoryTable.variantId, inventoryTable.locationId],
          set: {
            stock: sql`${inventoryTable.stock} + ${dto.delta}`,
            updatedAt: new Date(),
          },
        });

      return movement.id;
    });

    const [record] = await this.movementRecordsQuery(
      accountId,
      eq(inventoryMovementsTable.id, movementId),
    );
    return record;
  }

  async findMovements(
    limit: number,
    offset: number,
    accountId: number,
    filter: MovementFilter = {},
  ): Promise<PaginatedInventoryMovements> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = this.movementWhere(filter);

    const [items, [{ total }]] = await Promise.all([
      this.movementRecordsQuery(accountId, where)
        .orderBy(desc(inventoryMovementsTable.createdAt))
        .limit(take)
        .offset(skip),
      this.movementCountQuery(accountId, where),
    ]);

    return { items, total, limit: take, offset: skip };
  }

  private inventoryWhere(
    accountId: number,
    filter: InventoryFilter,
  ): SQL | undefined {
    const clauses: SQL[] = [eq(productsTable.accountId, accountId)];

    if (filter.productId != null) {
      clauses.push(eq(productsTable.id, filter.productId));
    }
    if (filter.locationId != null) {
      clauses.push(eq(inventoryTable.locationId, filter.locationId));
    }
    if (filter.stockLte != null) {
      clauses.push(lte(inventoryTable.stock, filter.stockLte));
    }

    const term = filter.q?.trim();
    if (term) {
      const like = `%${term}%`;
      const match = or(
        ilike(productVariantsTable.sku, like),
        ilike(productsTable.name, like),
      );
      if (match) clauses.push(match);
    }

    return and(...clauses);
  }

  private movementWhere(filter: MovementFilter): SQL | undefined {
    const clauses: SQL[] = [];
    if (filter.variantId != null) {
      clauses.push(eq(inventoryMovementsTable.variantId, filter.variantId));
    }
    if (filter.locationId != null) {
      clauses.push(eq(inventoryMovementsTable.locationId, filter.locationId));
    }
    if (filter.reason) {
      clauses.push(eq(inventoryMovementsTable.reason, filter.reason));
    }
    return clauses.length ? and(...clauses) : undefined;
  }

  private movementRecordsQuery(accountId: number, extraWhere?: SQL) {
    return this.db
      .select({
        id: inventoryMovementsTable.id,
        variantId: inventoryMovementsTable.variantId,
        sku: productVariantsTable.sku,
        productId: productsTable.id,
        productName: productsTable.name,
        locationId: locationsTable.id,
        locationName: locationsTable.name,
        delta: inventoryMovementsTable.delta,
        reason: inventoryMovementsTable.reason,
        note: inventoryMovementsTable.note,
        createdByEmail: usersTable.email,
        createdAt: inventoryMovementsTable.createdAt,
      })
      .from(inventoryMovementsTable)
      .innerJoin(
        productVariantsTable,
        eq(productVariantsTable.id, inventoryMovementsTable.variantId),
      )
      .innerJoin(
        productsTable,
        eq(productsTable.id, productVariantsTable.productId),
      )
      .innerJoin(
        locationsTable,
        eq(locationsTable.id, inventoryMovementsTable.locationId),
      )
      .leftJoin(
        usersTable,
        eq(usersTable.id, inventoryMovementsTable.createdByUserId),
      )
      .where(
        extraWhere
          ? and(eq(productsTable.accountId, accountId), extraWhere)
          : eq(productsTable.accountId, accountId),
      );
  }

  private movementCountQuery(accountId: number, extraWhere?: SQL) {
    return this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(inventoryMovementsTable)
      .innerJoin(
        productVariantsTable,
        eq(productVariantsTable.id, inventoryMovementsTable.variantId),
      )
      .innerJoin(
        productsTable,
        eq(productsTable.id, productVariantsTable.productId),
      )
      .innerJoin(
        locationsTable,
        eq(locationsTable.id, inventoryMovementsTable.locationId),
      )
      .where(
        extraWhere
          ? and(eq(productsTable.accountId, accountId), extraWhere)
          : eq(productsTable.accountId, accountId),
      );
  }
}
