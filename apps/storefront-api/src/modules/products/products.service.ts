import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../database/database.constants';
import { resolvePageParams } from '../../shared/pagination';
import {
  and,
  asc,
  brandsTable,
  categoriesTable,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  inventoryTable,
  isNull,
  lte,
  or,
  productBarcodesTable,
  productCategoriesTable,
  productImagesTable,
  productOptionsTable,
  productOptionValuesTable,
  productsTable,
  productVariantsTable,
  sql,
  variantOptionValuesTable,
  type db as Db,
  type SQL,
} from 'db';
import {
  ListProductsQueryDto,
  type ProductSortBy,
  type SortDirection,
} from './dto/list-products-query.dto';
import { ProductListItem } from './entities/product-list-item.entity';
import { PaginatedProducts } from './entities/paginated-products.entity';
import { ProductDetail } from './entities/product-detail.entity';
import { ProductImage } from './entities/product-image.entity';

@Injectable()
export class ProductsService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async findAll(
    {
      limit,
      offset,
      q,
      categoryId,
      brandId,
      minPriceCents,
      maxPriceCents,
      inStock,
      sortBy,
      sortDir,
    }: ListProductsQueryDto,
    accountId: number,
  ): Promise<PaginatedProducts> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);

    // only "active" products are ever visible through the storefront —
    // draft/archived are admin-only
    const where = and(
      eq(productsTable.accountId, accountId),
      eq(productsTable.status, 'active'),
      this.searchFilter(q),
      categoryId !== undefined
        ? exists(
            this.db
              .select({ one: sql`1` })
              .from(productCategoriesTable)
              .where(
                and(
                  eq(productCategoriesTable.productId, productsTable.id),
                  eq(productCategoriesTable.categoryId, categoryId),
                ),
              ),
          )
        : undefined,
      brandId !== undefined ? eq(productsTable.brandId, brandId) : undefined,
      this.priceRangeFilter(minPriceCents, maxPriceCents),
      inStock ? this.inStockFilter() : undefined,
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: productsTable.id,
          name: productsTable.name,
          description: productsTable.description,
          brandId: productsTable.brandId,
          // price range across a product's variants, not a stored field
          minPriceCents: sql<
            number | null
          >`min(${productVariantsTable.priceCents})`,
          maxPriceCents: sql<
            number | null
          >`max(${productVariantsTable.priceCents})`,
        })
        .from(productsTable)
        .leftJoin(
          productVariantsTable,
          eq(productVariantsTable.productId, productsTable.id),
        )
        .where(where)
        .groupBy(productsTable.id)
        .orderBy(...this.sortColumns(sortBy, sortDir))
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(productsTable)
        .where(where),
    ]);

    const [brandsById, categoriesByProduct, thumbnailByProduct] =
      await Promise.all([
        this.selectBrands([
          ...new Set(rows.map((r) => r.brandId).filter((id) => id !== null)),
        ]),
        this.selectCategories(rows.map((r) => r.id)),
        this.selectThumbnails(rows.map((r) => r.id)),
      ]);

    const items: ProductListItem[] = rows.map(({ brandId, ...row }) => ({
      ...row,
      brand: brandId !== null ? (brandsById.get(brandId) ?? null) : null,
      categories: categoriesByProduct.get(row.id) ?? [],
      thumbnailUrl: thumbnailByProduct.get(row.id) ?? null,
    }));

    return { items, total, limit: take, offset: skip };
  }

  // 'price' sorts on the same min(priceCents) aggregate the select already
  // computes — recomputing it here is fine, it's grouped the same way.
  // Always appends id as a tiebreaker so pagination stays stable when the
  // primary key has duplicates (e.g. two products with the same name).
  // No sortBy at all keeps the original id-only ordering, unchanged.
  private sortColumns(
    sortBy: ProductSortBy | undefined,
    sortDir: SortDirection | undefined,
  ): SQL[] {
    if (!sortBy) return [asc(productsTable.id)];

    const dir = sortDir === 'desc' ? desc : asc;
    const primary =
      sortBy === 'price'
        ? sql`min(${productVariantsTable.priceCents})`
        : sortBy === 'newest'
          ? productsTable.createdAt
          : productsTable.name;

    return [dir(primary), asc(productsTable.id)];
  }

  // True if the product has at least one variant priced within
  // [minCents, maxCents]. An EXISTS subquery, not a filter on the outer
  // leftJoin, so findAll's min/max price aggregation still sees every
  // variant rather than only the ones inside the requested range.
  private priceRangeFilter(
    minCents: number | undefined,
    maxCents: number | undefined,
  ): SQL | undefined {
    if (minCents === undefined && maxCents === undefined) return undefined;

    return exists(
      this.db
        .select({ one: sql`1` })
        .from(productVariantsTable)
        .where(
          and(
            eq(productVariantsTable.productId, productsTable.id),
            minCents !== undefined
              ? gte(productVariantsTable.priceCents, minCents)
              : undefined,
            maxCents !== undefined
              ? lte(productVariantsTable.priceCents, maxCents)
              : undefined,
          ),
        ),
    );
  }

  // True if at least one variant's stock (summed across locations) is > 0.
  private inStockFilter(): SQL {
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(productVariantsTable)
        .leftJoin(
          inventoryTable,
          eq(inventoryTable.variantId, productVariantsTable.id),
        )
        .where(eq(productVariantsTable.productId, productsTable.id))
        .groupBy(productVariantsTable.id)
        .having(sql`coalesce(sum(${inventoryTable.stock}), 0) > 0`),
    );
  }

  // Matches on the product's own name, or — via correlated EXISTS
  // subqueries, so the price-aggregation join in findAll still sees *all*
  // of a matching product's variants, not just the one whose SKU/code
  // matched — a variant's SKU or one of its barcodes. Description search is
  // deliberately left out for now.
  private searchFilter(q: string | undefined): SQL | undefined {
    const term = q?.trim();
    if (!term) return undefined;

    const like = `%${term}%`;
    return or(
      ilike(productsTable.name, like),
      exists(
        this.db
          .select({ one: sql`1` })
          .from(productVariantsTable)
          .where(
            and(
              eq(productVariantsTable.productId, productsTable.id),
              ilike(productVariantsTable.sku, like),
            ),
          ),
      ),
      exists(
        this.db
          .select({ one: sql`1` })
          .from(productBarcodesTable)
          .innerJoin(
            productVariantsTable,
            eq(productVariantsTable.id, productBarcodesTable.variantId),
          )
          .where(
            and(
              eq(productVariantsTable.productId, productsTable.id),
              ilike(productBarcodesTable.code, like),
            ),
          ),
      ),
    );
  }

  async findOne(
    id: number,
    accountId: number,
  ): Promise<ProductDetail | undefined> {
    const [product] = await this.db
      .select({
        id: productsTable.id,
        name: productsTable.name,
        description: productsTable.description,
        brandId: productsTable.brandId,
      })
      .from(productsTable)
      .where(
        and(
          eq(productsTable.id, id),
          eq(productsTable.accountId, accountId),
          eq(productsTable.status, 'active'),
        ),
      );
    if (!product) return undefined;

    const [brandsById, categoriesByProduct, options, variants, images] =
      await Promise.all([
        product.brandId !== null
          ? this.selectBrands([product.brandId])
          : undefined,
        this.selectCategories([product.id]),
        this.selectOptions(product.id),
        this.selectVariants(product.id),
        this.selectImages(
          and(
            eq(productImagesTable.productId, product.id),
            isNull(productImagesTable.variantId),
          ),
        ),
      ]);

    const { brandId, ...rest } = product;
    return {
      ...rest,
      brand: brandId !== null ? (brandsById?.get(brandId) ?? null) : null,
      categories: categoriesByProduct.get(product.id) ?? [],
      options,
      variants,
      images,
    };
  }

  private async selectOptions(
    productId: number,
  ): Promise<
    { id: number; name: string; values: { id: number; value: string }[] }[]
  > {
    const rows = await this.db
      .select({
        optionId: productOptionsTable.id,
        optionName: productOptionsTable.name,
        valueId: productOptionValuesTable.id,
        value: productOptionValuesTable.value,
      })
      .from(productOptionsTable)
      .leftJoin(
        productOptionValuesTable,
        eq(productOptionValuesTable.optionId, productOptionsTable.id),
      )
      .where(eq(productOptionsTable.productId, productId));

    const options = new Map<
      number,
      { id: number; name: string; values: { id: number; value: string }[] }
    >();
    for (const row of rows) {
      let option = options.get(row.optionId);
      if (!option) {
        option = { id: row.optionId, name: row.optionName, values: [] };
        options.set(row.optionId, option);
      }
      if (row.valueId !== null) {
        option.values.push({ id: row.valueId, value: row.value! });
      }
    }
    return Array.from(options.values());
  }

  // stock is derived — summed across a variant's per-location inventory
  // rows rather than read off a single stored field
  private async selectVariants(productId: number) {
    const variants = await this.db
      .select({
        id: productVariantsTable.id,
        sku: productVariantsTable.sku,
        priceCents: productVariantsTable.priceCents,
        stock: sql<number>`coalesce(sum(${inventoryTable.stock}), 0)::int`,
      })
      .from(productVariantsTable)
      .leftJoin(
        inventoryTable,
        eq(inventoryTable.variantId, productVariantsTable.id),
      )
      .where(eq(productVariantsTable.productId, productId))
      .groupBy(productVariantsTable.id);

    if (variants.length === 0) return [];

    const optionValueRows = await this.db
      .select({
        variantId: variantOptionValuesTable.variantId,
        optionName: productOptionsTable.name,
        value: productOptionValuesTable.value,
      })
      .from(variantOptionValuesTable)
      .innerJoin(
        productOptionValuesTable,
        eq(productOptionValuesTable.id, variantOptionValuesTable.optionValueId),
      )
      .innerJoin(
        productOptionsTable,
        eq(productOptionsTable.id, productOptionValuesTable.optionId),
      )
      .where(
        inArray(
          variantOptionValuesTable.variantId,
          variants.map((v) => v.id),
        ),
      );

    const optionValuesByVariant = new Map<
      number,
      { optionName: string; value: string }[]
    >();
    for (const row of optionValueRows) {
      const values = optionValuesByVariant.get(row.variantId) ?? [];
      values.push({ optionName: row.optionName, value: row.value });
      optionValuesByVariant.set(row.variantId, values);
    }

    const imageRows = await this.db
      .select()
      .from(productImagesTable)
      .where(
        inArray(
          productImagesTable.variantId,
          variants.map((v) => v.id),
        ),
      )
      .orderBy(productImagesTable.position);

    const imagesByVariant = new Map<number, ProductImage[]>();
    for (const row of imageRows) {
      if (row.variantId === null) continue;
      const images = imagesByVariant.get(row.variantId) ?? [];
      images.push({ id: row.id, url: row.url, position: row.position });
      imagesByVariant.set(row.variantId, images);
    }

    return variants.map((variant) => ({
      ...variant,
      optionValues: optionValuesByVariant.get(variant.id) ?? [],
      images: imagesByVariant.get(variant.id) ?? [],
    }));
  }

  private async selectImages(where: SQL | undefined): Promise<ProductImage[]> {
    const rows = await this.db
      .select()
      .from(productImagesTable)
      .where(where)
      .orderBy(productImagesTable.position);
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      position: row.position,
    }));
  }

  private async selectThumbnails(
    productIds: number[],
  ): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (productIds.length === 0) return map;

    const rows = await this.db
      .select({
        productId: productImagesTable.productId,
        url: productImagesTable.url,
      })
      .from(productImagesTable)
      .where(
        and(
          inArray(productImagesTable.productId, productIds),
          isNull(productImagesTable.variantId),
        ),
      )
      .orderBy(productImagesTable.position);

    for (const row of rows) {
      if (!map.has(row.productId)) {
        map.set(row.productId, row.url);
      }
    }
    return map;
  }

  private async selectBrands(
    brandIds: number[],
  ): Promise<Map<number, { id: number; name: string }>> {
    const map = new Map<number, { id: number; name: string }>();
    if (brandIds.length === 0) return map;

    const rows = await this.db
      .select({ id: brandsTable.id, name: brandsTable.name })
      .from(brandsTable)
      .where(inArray(brandsTable.id, brandIds));

    for (const row of rows) {
      map.set(row.id, row);
    }
    return map;
  }

  private async selectCategories(
    productIds: number[],
  ): Promise<Map<number, { id: number; name: string }[]>> {
    const map = new Map<number, { id: number; name: string }[]>();
    if (productIds.length === 0) return map;

    const rows = await this.db
      .select({
        productId: productCategoriesTable.productId,
        id: categoriesTable.id,
        name: categoriesTable.name,
      })
      .from(productCategoriesTable)
      .innerJoin(
        categoriesTable,
        eq(categoriesTable.id, productCategoriesTable.categoryId),
      )
      .where(inArray(productCategoriesTable.productId, productIds));

    for (const row of rows) {
      const categories = map.get(row.productId) ?? [];
      categories.push({ id: row.id, name: row.name });
      map.set(row.productId, categories);
    }
    return map;
  }
}
