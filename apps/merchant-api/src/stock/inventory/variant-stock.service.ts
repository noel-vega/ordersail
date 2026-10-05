import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { resolvePageParams } from 'src/shared/pagination';
import {
  productOptionsTable,
  productOptionValuesTable,
  productsTable,
  productVariantsTable,
  variantOptionValuesTable,
} from 'db/catalog';
import {
  and,
  asc,
  type db as Db,
  eq,
  ilike,
  inventoryTable,
  locationsTable,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'db/stock';
import { readLowStockThreshold } from './low-stock-threshold';
import {
  PaginatedVariantStock,
  VariantLocationStock,
} from './entities/variant-stock.entity';

export interface VariantStockFilter {
  q?: string;
  productId?: number;
  // summed stock <= the account's lowStockThreshold — low or out
  lowStock?: boolean;
}

export interface VariantStockCounts {
  outOfStockCount: number;
  lowStockCount: number;
  lowStockThreshold: number;
}

// Stock judged per variant, summed across every location (OS-195, OS-693).
// The one definition of "out of stock" and "low stock" — the dashboard's
// counts and Low stock card read it through platform/dashboard's StockPort,
// and GET /inventory/variants lists it, so the two always agree. A variant is
// out when it can't be sold anywhere, not when one location runs dry.
@Injectable()
export class VariantStockService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  // With lowStock the list is most urgent first — out of stock (<= 0) ahead
  // of merely low — so its first page is the dashboard's Low stock card.
  // Otherwise it's by product name, like GET /inventory.
  async findAll(
    limit: number,
    offset: number,
    accountId: number,
    filter: VariantStockFilter = {},
  ): Promise<PaginatedVariantStock> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const lowStockThreshold = await readLowStockThreshold(this.db, accountId);
    const stock = this.variantStock(accountId);

    const clauses: SQL[] = [];
    if (filter.productId != null) {
      clauses.push(eq(productsTable.id, filter.productId));
    }
    if (filter.lowStock) {
      clauses.push(lte(stock.total, lowStockThreshold));
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
    const where = clauses.length ? and(...clauses) : undefined;
    const order = filter.lowStock
      ? [asc(stock.total), asc(productsTable.name), asc(stock.variantId)]
      : [asc(productsTable.name), asc(stock.variantId)];

    const [items, [{ total }]] = await Promise.all([
      this.db
        .select({
          variantId: stock.variantId,
          productId: productsTable.id,
          productName: productsTable.name,
          sku: productVariantsTable.sku,
          // "Blue / Large", in option order; null for a variant with no options
          optionsLabel: sql<string | null>`(
            select string_agg(${productOptionValuesTable.value}, ' / ' order by ${productOptionsTable.id})
            from ${variantOptionValuesTable}
            inner join ${productOptionValuesTable} on ${productOptionValuesTable.id} = ${variantOptionValuesTable.optionValueId}
            inner join ${productOptionsTable} on ${productOptionsTable.id} = ${productOptionValuesTable.optionId}
            where ${variantOptionValuesTable.variantId} = ${stock.variantId}
          )`,
          stock: stock.total,
          // the rows `stock` sums; node-postgres parses the json
          locations: sql<VariantLocationStock[]>`coalesce((
            select json_agg(json_build_object(
              'locationId', ${locationsTable.id},
              'locationName', ${locationsTable.name},
              'stock', ${inventoryTable.stock}
            ) order by ${locationsTable.name}, ${locationsTable.id})
            from ${inventoryTable}
            inner join ${locationsTable} on ${locationsTable.id} = ${inventoryTable.locationId}
            where ${inventoryTable.variantId} = ${stock.variantId}
          ), '[]'::json)`,
        })
        .from(stock)
        .innerJoin(
          productVariantsTable,
          eq(productVariantsTable.id, stock.variantId),
        )
        .innerJoin(
          productsTable,
          eq(productsTable.id, productVariantsTable.productId),
        )
        .where(where)
        .orderBy(...order)
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(stock)
        .innerJoin(
          productVariantsTable,
          eq(productVariantsTable.id, stock.variantId),
        )
        .innerJoin(
          productsTable,
          eq(productsTable.id, productVariantsTable.productId),
        )
        .where(where),
    ]);

    return { items, total, limit: take, offset: skip, lowStockThreshold };
  }

  // out-of-stock and low-stock variant counts in one aggregate; low excludes
  // out, so together they're exactly findAll's lowStock total
  async counts(accountId: number): Promise<VariantStockCounts> {
    const lowStockThreshold = await readLowStockThreshold(this.db, accountId);
    const stock = this.variantStock(accountId);
    const [counts] = await this.db
      .select({
        outOfStockCount: sql<number>`count(*) filter (where ${stock.total} <= 0)::int`,
        lowStockCount: sql<number>`count(*) filter (where ${stock.total} > 0 and ${stock.total} <= ${lowStockThreshold})::int`,
      })
      .from(stock);
    return { ...counts, lowStockThreshold };
  }

  // Each of the account's variants with its stock summed across locations,
  // 0 for a variant with no inventory rows yet. Archived products are left
  // out — they're off sale, so their stock isn't a problem to act on.
  private variantStock(accountId: number) {
    return this.db
      .select({
        variantId: sql<number>`${productVariantsTable.id}`.as('variant_id'),
        total: sql<number>`coalesce(sum(${inventoryTable.stock}), 0)::int`.as(
          'total',
        ),
      })
      .from(productVariantsTable)
      .innerJoin(
        productsTable,
        eq(productsTable.id, productVariantsTable.productId),
      )
      .leftJoin(
        inventoryTable,
        eq(inventoryTable.variantId, productVariantsTable.id),
      )
      .where(
        and(
          eq(productsTable.accountId, accountId),
          ne(productsTable.status, 'archived'),
        ),
      )
      .groupBy(productVariantsTable.id)
      .as('variant_stock');
  }
}
