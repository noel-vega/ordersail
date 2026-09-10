import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateVariantsDto } from './dto/create-variant.dto';
import { UpdateProductOptionDto } from './dto/update-product-option.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { GetImageUploadUrlDto } from './dto/get-image-upload-url.dto';
import { CreateProductImageDto } from './dto/create-product-image.dto';
import { ReorderProductImagesDto } from './dto/reorder-product-images.dto';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { resolvePageParams } from 'src/shared/pagination';
import {
  and,
  brandsTable,
  categoriesTable,
  type db as Db,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  notInArray,
  or,
  productBarcodesTable,
  productCategoriesTable,
  productImagesTable,
  productOptionsTable,
  productOptionValuesTable,
  productsTable,
  productStatusEnum,
  productVariantsTable,
  sql,
  type SQL,
  variantOptionValuesTable,
} from 'db/catalog';
import { inventoryTable, locationsTable } from 'db/stock';
import { PaginatedProducts } from './entities/paginated-products.entity';

export type ProductStatus = (typeof productStatusEnum.enumValues)[number];
import { ProductVariant } from './entities/product-variant.entity';
import { ProductOption } from './entities/product-option.entity';
import { ProductDetail } from './entities/product-detail.entity';
import { ProductImage } from './entities/product-image.entity';
import { StorageService } from 'src/shared/storage/storage.service';
import { generateToken } from '../../shared/common/generate-token.util';

function toProductImage(
  row: typeof productImagesTable.$inferSelect,
): ProductImage {
  return {
    id: row.id,
    url: row.url,
    position: row.position,
    variantId: row.variantId,
  };
}

// trim, drop blanks, dedupe (preserving first-seen order) — used for both
// create and the full-replace on updateVariant
function normalizeBarcodes(barcodes: string[] | undefined): string[] {
  if (!barcodes) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of barcodes) {
    const code = raw.trim();
    if (code.length === 0 || seen.has(code)) continue;
    seen.add(code);
    result.push(code);
  }
  return result;
}

// every combination of one value per option, e.g. [[1,2],[3,4]] -> [[1,3],[1,4],[2,3],[2,4]]
function cartesianProduct<T>(groups: T[][]): T[][] {
  return groups.reduce<T[][]>(
    (acc, group) =>
      acc.flatMap((combo) => group.map((value) => [...combo, value])),
    [[]],
  );
}

@Injectable()
export class ProductsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private readonly storageService: StorageService,
  ) {}
  async create(createProductDto: CreateProductDto, accountId: number) {
    const [brand] = await this.db
      .select({ id: brandsTable.id })
      .from(brandsTable)
      .where(
        and(
          eq(brandsTable.id, createProductDto.brandId),
          eq(brandsTable.accountId, accountId),
        ),
      );
    if (!brand) {
      throw new BadRequestException('Brand not found');
    }

    if (createProductDto.categoryIds.length > 0) {
      const ownedCategories = await this.db
        .select({ id: categoriesTable.id })
        .from(categoriesTable)
        .where(
          and(
            eq(categoriesTable.accountId, accountId),
            inArray(categoriesTable.id, createProductDto.categoryIds),
          ),
        );
      if (ownedCategories.length !== createProductDto.categoryIds.length) {
        throw new BadRequestException('One or more categories not found');
      }
    }

    const product = await this.db.transaction(async (tx) => {
      const [product] = await tx
        .insert(productsTable)
        .values({
          accountId,
          name: createProductDto.name,
          description: createProductDto.description,
          status: createProductDto.status,
          brandId: createProductDto.brandId,
        })
        .returning();

      const [variant] = await tx
        .insert(productVariantsTable)
        .values({
          priceCents: createProductDto.priceCents,
          productId: product.id,
          sku: createProductDto.sku,
        })
        .returning();

      const [location] = await tx
        .select({ id: locationsTable.id })
        .from(locationsTable)
        .where(eq(locationsTable.accountId, accountId))
        .limit(1);
      await tx.insert(inventoryTable).values({
        variantId: variant.id,
        locationId: location.id,
        stock: createProductDto.stock,
      });

      const barcodes = normalizeBarcodes(createProductDto.barcodes);
      if (barcodes.length > 0) {
        await tx
          .insert(productBarcodesTable)
          .values(barcodes.map((code) => ({ variantId: variant.id, code })));
      }

      if (createProductDto.categoryIds.length > 0) {
        await tx.insert(productCategoriesTable).values(
          createProductDto.categoryIds.map((categoryId) => ({
            productId: product.id,
            categoryId,
          })),
        );
      }

      return product;
    });
    return product;
  }

  async findAll(
    limit: number,
    offset: number,
    accountId: number,
    opts: { q?: string; status?: ProductStatus } = {},
  ): Promise<PaginatedProducts> {
    const { limit: take, offset: skip } = resolvePageParams(limit, offset);
    const where = this.listFilter(accountId, opts);

    const [products, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(productsTable)
        .where(where)
        .orderBy(desc(productsTable.createdAt), desc(productsTable.id))
        .limit(take)
        .offset(skip),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(productsTable)
        .where(where),
    ]);

    if (products.length === 0) {
      return { items: [], total, limit: take, offset: skip };
    }

    // first product-level image per product, for the list-view thumbnail —
    // a single batched query rather than N+1 per row
    const thumbnailRows = await this.db
      .select({
        productId: productImagesTable.productId,
        url: productImagesTable.url,
      })
      .from(productImagesTable)
      .where(
        and(
          inArray(
            productImagesTable.productId,
            products.map((p) => p.id),
          ),
          isNull(productImagesTable.variantId),
        ),
      )
      .orderBy(productImagesTable.position);

    const thumbnailByProduct = new Map<number, string>();
    for (const row of thumbnailRows) {
      if (!thumbnailByProduct.has(row.productId)) {
        thumbnailByProduct.set(row.productId, row.url);
      }
    }

    return {
      items: products.map((product) => ({
        ...product,
        thumbnailUrl: thumbnailByProduct.get(product.id) ?? null,
      })),
      total,
      limit: take,
      offset: skip,
    };
  }

  private listFilter(
    accountId: number,
    opts: { q?: string; status?: ProductStatus },
  ): SQL | undefined {
    const clauses: SQL[] = [eq(productsTable.accountId, accountId)];

    if (opts.status) {
      clauses.push(eq(productsTable.status, opts.status));
    }

    const term = opts.q?.trim();
    if (term) {
      const like = `%${term}%`;
      const match = or(
        ilike(productsTable.name, like),
        ilike(productsTable.description, like),
      );
      if (match) clauses.push(match);
    }

    return and(...clauses);
  }

  async findOne(
    id: number,
    accountId: number,
  ): Promise<ProductDetail | undefined> {
    const [product] = await this.db
      .select()
      .from(productsTable)
      .where(
        and(eq(productsTable.id, id), eq(productsTable.accountId, accountId)),
      );
    if (!product) return undefined;

    const [brand] = product.brandId
      ? await this.db
          .select()
          .from(brandsTable)
          .where(eq(brandsTable.id, product.brandId))
      : [];

    const categoryLinks = await this.db
      .select({ categoryId: productCategoriesTable.categoryId })
      .from(productCategoriesTable)
      .where(eq(productCategoriesTable.productId, id));

    const images = await this.selectImages(
      and(
        eq(productImagesTable.productId, id),
        isNull(productImagesTable.variantId),
      ),
    );

    const { brandId, ...rest } = product;
    return {
      ...rest,
      brand: brand ?? null,
      categoryIds: categoryLinks.map((link) => link.categoryId),
      images,
    };
  }

  private async selectImages(where: SQL | undefined): Promise<ProductImage[]> {
    const rows = await this.db
      .select()
      .from(productImagesTable)
      .where(where)
      .orderBy(productImagesTable.position);
    return rows.map(toProductImage);
  }

  // folds each variant's own images in (empty when it has none) — a
  // separate query since it's keyed off variantId, not the option-value join
  private async attachImages<T extends { id: number }>(
    variants: T[],
  ): Promise<(T & { images: ProductImage[] })[]> {
    if (variants.length === 0) return [];

    const rows = await this.db
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
    for (const row of rows) {
      if (row.variantId === null) continue;
      const images = imagesByVariant.get(row.variantId) ?? [];
      images.push(toProductImage(row));
      imagesByVariant.set(row.variantId, images);
    }

    return variants.map((variant) => ({
      ...variant,
      images: imagesByVariant.get(variant.id) ?? [],
    }));
  }

  // every nested product resource (variants/options) is reached only via a
  // productId, so ownership is checked here once rather than on every table
  private async productExists(
    productId: number,
    accountId: number,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(
        and(
          eq(productsTable.id, productId),
          eq(productsTable.accountId, accountId),
        ),
      );
    return !!row;
  }

  async findVariants(
    productId: number,
    accountId: number,
  ): Promise<ProductVariant[]> {
    if (!(await this.productExists(productId, accountId))) return [];

    const variants = await this.selectVariants(
      eq(productVariantsTable.productId, productId),
    );
    const withOptions = await this.attachOptionValues(variants);
    const withBarcodes = await this.attachBarcodes(withOptions);
    return await this.attachImages(withBarcodes);
  }

  // stock is derived — summed across a variant's per-location inventory
  // rows rather than read off a single stored field
  private selectVariants(where: SQL) {
    return this.db
      .select({
        id: productVariantsTable.id,
        productId: productVariantsTable.productId,
        priceCents: productVariantsTable.priceCents,
        sku: productVariantsTable.sku,
        weightOz: productVariantsTable.weightOz,
        createdAt: productVariantsTable.createdAt,
        updatedAt: productVariantsTable.updatedAt,
        stock: sql<number>`coalesce(sum(${inventoryTable.stock}), 0)::int`,
      })
      .from(productVariantsTable)
      .leftJoin(
        inventoryTable,
        eq(inventoryTable.variantId, productVariantsTable.id),
      )
      .where(where)
      .groupBy(productVariantsTable.id);
  }

  async updateVariant(
    productId: number,
    variantId: number,
    updateVariantDto: UpdateVariantDto,
    accountId: number,
  ): Promise<ProductVariant | undefined> {
    if (!(await this.productExists(productId, accountId))) return undefined;

    const { barcodes, ...variantFields } = updateVariantDto;

    await this.db.transaction(async (tx) => {
      if (Object.keys(variantFields).length > 0) {
        await tx
          .update(productVariantsTable)
          .set({ ...variantFields, updatedAt: new Date() })
          .where(
            and(
              eq(productVariantsTable.id, variantId),
              eq(productVariantsTable.productId, productId),
            ),
          );
      }

      // full replace — the client sends the complete desired set, same as
      // category replacement on update()
      if (barcodes !== undefined) {
        await tx
          .delete(productBarcodesTable)
          .where(eq(productBarcodesTable.variantId, variantId));
        const codes = normalizeBarcodes(barcodes);
        if (codes.length > 0) {
          await tx
            .insert(productBarcodesTable)
            .values(codes.map((code) => ({ variantId, code })));
        }
      }
    });

    const variants = await this.selectVariants(
      eq(productVariantsTable.id, variantId),
    );
    if (variants.length === 0) return undefined;

    const withOptions = await this.attachOptionValues(variants);
    const withBarcodes = await this.attachBarcodes(withOptions);
    const [record] = await this.attachImages(withBarcodes);
    return record;
  }

  // fills in each variant's option-value combination (e.g. "Size: 9"), which
  // requires a separate query since it's a many-to-many join
  private async attachOptionValues<T extends { id: number }>(
    variants: T[],
  ): Promise<
    (T & { optionValues: { optionName: string; value: string }[] })[]
  > {
    if (variants.length === 0) return [];

    const rows = await this.db
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
    for (const row of rows) {
      const values = optionValuesByVariant.get(row.variantId) ?? [];
      values.push({ optionName: row.optionName, value: row.value });
      optionValuesByVariant.set(row.variantId, values);
    }

    return variants.map((variant) => ({
      ...variant,
      optionValues: optionValuesByVariant.get(variant.id) ?? [],
    }));
  }

  // folds each variant's scannable codes in — a separate query keyed off
  // variantId, same shape as attachOptionValues
  private async attachBarcodes<T extends { id: number }>(
    variants: T[],
  ): Promise<(T & { barcodes: string[] })[]> {
    if (variants.length === 0) return [];

    const rows = await this.db
      .select({
        variantId: productBarcodesTable.variantId,
        code: productBarcodesTable.code,
      })
      .from(productBarcodesTable)
      .where(
        inArray(
          productBarcodesTable.variantId,
          variants.map((v) => v.id),
        ),
      )
      .orderBy(productBarcodesTable.id);

    const byVariant = new Map<number, string[]>();
    for (const row of rows) {
      const codes = byVariant.get(row.variantId) ?? [];
      codes.push(row.code);
      byVariant.set(row.variantId, codes);
    }

    return variants.map((variant) => ({
      ...variant,
      barcodes: byVariant.get(variant.id) ?? [],
    }));
  }

  async findOptions(
    productId: number,
    accountId: number,
  ): Promise<ProductOption[]> {
    if (!(await this.productExists(productId, accountId))) return [];

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

    const options = new Map<number, ProductOption>();
    for (const row of rows) {
      let option = options.get(row.optionId);
      if (!option) {
        option = {
          id: row.optionId,
          productId,
          name: row.optionName,
          values: [],
        };
        options.set(row.optionId, option);
      }
      if (row.valueId !== null) {
        option.values.push({ id: row.valueId, value: row.value! });
      }
    }

    return Array.from(options.values());
  }

  async updateOption(
    productId: number,
    optionId: number,
    updateProductOptionDto: UpdateProductOptionDto,
    accountId: number,
  ): Promise<ProductOption | undefined> {
    if (!(await this.productExists(productId, accountId))) return undefined;

    await this.db
      .update(productOptionsTable)
      .set({ name: updateProductOptionDto.name })
      .where(
        and(
          eq(productOptionsTable.id, optionId),
          eq(productOptionsTable.productId, productId),
        ),
      );

    const options = await this.findOptions(productId, accountId);
    return options.find((o) => o.id === optionId);
  }

  async removeOptionValue(
    productId: number,
    optionId: number,
    valueId: number,
    accountId: number,
  ): Promise<ProductOption | undefined> {
    if (!(await this.productExists(productId, accountId))) return undefined;

    const [option] = await this.db
      .select()
      .from(productOptionsTable)
      .where(
        and(
          eq(productOptionsTable.id, optionId),
          eq(productOptionsTable.productId, productId),
        ),
      );
    if (!option) return undefined;

    // cascades to variant_option_values — variants that used this value are
    // kept, they just lose that dimension
    await this.db
      .delete(productOptionValuesTable)
      .where(
        and(
          eq(productOptionValuesTable.id, valueId),
          eq(productOptionValuesTable.optionId, optionId),
        ),
      );

    const options = await this.findOptions(productId, accountId);
    return options.find((o) => o.id === optionId);
  }

  async removeOption(
    productId: number,
    optionId: number,
    accountId: number,
  ): Promise<ProductOption | undefined> {
    if (!(await this.productExists(productId, accountId))) return undefined;

    const options = await this.findOptions(productId, accountId);
    const option = options.find((o) => o.id === optionId);

    await this.db
      .delete(productOptionsTable)
      .where(
        and(
          eq(productOptionsTable.id, optionId),
          eq(productOptionsTable.productId, productId),
        ),
      );

    return option;
  }

  async update(
    id: number,
    updateProductDto: UpdateProductDto,
    accountId: number,
  ) {
    const { categoryIds, ...productFields } = updateProductDto;

    return await this.db.transaction(async (tx) => {
      const [product] = await tx
        .update(productsTable)
        .set(productFields)
        .where(
          and(eq(productsTable.id, id), eq(productsTable.accountId, accountId)),
        )
        .returning();

      if (!product) return undefined;

      if (categoryIds !== undefined) {
        // full replace — simpler than diffing, and category sets are small
        await tx
          .delete(productCategoriesTable)
          .where(eq(productCategoriesTable.productId, id));

        if (categoryIds.length > 0) {
          await tx
            .insert(productCategoriesTable)
            .values(
              categoryIds.map((categoryId) => ({ productId: id, categoryId })),
            );
        }
      }

      return product;
    });
  }

  async remove(id: number, accountId: number) {
    const [product] = await this.db
      .delete(productsTable)
      .where(
        and(eq(productsTable.id, id), eq(productsTable.accountId, accountId)),
      )
      .returning();
    return product;
  }

  async createVariants(
    productId: number,
    createVariantsDto: CreateVariantsDto,
    accountId: number,
  ): Promise<ProductVariant[]> {
    if (!(await this.productExists(productId, accountId))) return [];

    const variantIds = await this.db.transaction(async (tx) => {
      const optionValueGroups: number[][] = [];

      for (const option of createVariantsDto.options) {
        let [productOption] = await tx
          .select()
          .from(productOptionsTable)
          .where(
            and(
              eq(productOptionsTable.productId, productId),
              eq(productOptionsTable.name, option.name),
            ),
          );

        if (!productOption) {
          [productOption] = await tx
            .insert(productOptionsTable)
            .values({ productId, name: option.name })
            .returning();
        }

        const optionValueIds: number[] = [];
        for (const value of option.values) {
          let [optionValue] = await tx
            .select()
            .from(productOptionValuesTable)
            .where(
              and(
                eq(productOptionValuesTable.optionId, productOption.id),
                eq(productOptionValuesTable.value, value),
              ),
            );

          if (!optionValue) {
            [optionValue] = await tx
              .insert(productOptionValuesTable)
              .values({ optionId: productOption.id, value })
              .returning();
          }

          optionValueIds.push(optionValue.id);
        }

        optionValueGroups.push(optionValueIds);
      }

      const combinations = cartesianProduct(optionValueGroups);

      // a combination that already has a variant should be reused, not duplicated
      const existingLinks = await tx
        .select({
          variantId: variantOptionValuesTable.variantId,
          optionValueId: variantOptionValuesTable.optionValueId,
        })
        .from(variantOptionValuesTable)
        .innerJoin(
          productVariantsTable,
          eq(productVariantsTable.id, variantOptionValuesTable.variantId),
        )
        .where(eq(productVariantsTable.productId, productId));

      const optionValueIdsByVariant = new Map<number, number[]>();
      for (const link of existingLinks) {
        const ids = optionValueIdsByVariant.get(link.variantId) ?? [];
        ids.push(link.optionValueId);
        optionValueIdsByVariant.set(link.variantId, ids);
      }

      const comboKey = (optionValueIds: number[]) =>
        [...optionValueIds].sort((a, b) => a - b).join(',');

      const existingVariantIdByCombo = new Map<string, number>();
      for (const [variantId, optionValueIds] of optionValueIdsByVariant) {
        existingVariantIdByCombo.set(comboKey(optionValueIds), variantId);
      }

      const variantIds: number[] = [];
      let defaultLocationId: number | undefined;

      for (const combination of combinations) {
        const existingVariantId = existingVariantIdByCombo.get(
          comboKey(combination),
        );
        if (existingVariantId !== undefined) {
          variantIds.push(existingVariantId);
          continue;
        }

        const [variant] = await tx
          .insert(productVariantsTable)
          .values({ productId, priceCents: createVariantsDto.priceCents })
          .returning();

        if (defaultLocationId === undefined) {
          const [location] = await tx
            .select({ id: locationsTable.id })
            .from(locationsTable)
            .where(eq(locationsTable.accountId, accountId))
            .limit(1);
          defaultLocationId = location.id;
        }

        await tx.insert(inventoryTable).values({
          variantId: variant.id,
          locationId: defaultLocationId,
          stock: createVariantsDto.stock,
        });

        await tx.insert(variantOptionValuesTable).values(
          combination.map((optionValueId) => ({
            variantId: variant.id,
            optionValueId,
          })),
        );

        variantIds.push(variant.id);
      }

      // a variant only makes sense if it has a value for every current
      // option — drop anything left over from before an option was added,
      // or from a value that was since removed
      if (variantIds.length > 0) {
        await tx
          .delete(productVariantsTable)
          .where(
            and(
              eq(productVariantsTable.productId, productId),
              notInArray(productVariantsTable.id, variantIds),
            ),
          );
      }

      return variantIds;
    });

    const variants = await this.selectVariants(
      inArray(productVariantsTable.id, variantIds),
    );
    const withOptions = await this.attachOptionValues(variants);
    const withBarcodes = await this.attachBarcodes(withOptions);
    return await this.attachImages(withBarcodes);
  }

  async getImageUploadUrl(
    productId: number,
    accountId: number,
    dto: GetImageUploadUrlDto,
  ): Promise<{ uploadUrl: string; key: string } | undefined> {
    if (!(await this.productExists(productId, accountId))) return undefined;

    const extension = dto.contentType.split('/')[1];
    const key = `products/${productId}/${generateToken(16)}.${extension}`;
    const uploadUrl = await this.storageService.getUploadUrl(
      key,
      dto.contentType,
    );
    return { uploadUrl, key };
  }

  async createImage(
    productId: number,
    accountId: number,
    dto: CreateProductImageDto,
  ): Promise<ProductImage | undefined> {
    if (!(await this.productExists(productId, accountId))) return undefined;

    if (dto.variantId !== undefined) {
      const [variant] = await this.db
        .select({ id: productVariantsTable.id })
        .from(productVariantsTable)
        .where(
          and(
            eq(productVariantsTable.id, dto.variantId),
            eq(productVariantsTable.productId, productId),
          ),
        );
      if (!variant) return undefined;
    }

    const groupWhere =
      dto.variantId !== undefined
        ? eq(productImagesTable.variantId, dto.variantId)
        : and(
            eq(productImagesTable.productId, productId),
            isNull(productImagesTable.variantId),
          );

    const [{ maxPosition }] = await this.db
      .select({
        maxPosition: sql<number>`coalesce(max(${productImagesTable.position}), -1)`,
      })
      .from(productImagesTable)
      .where(groupWhere);

    const [row] = await this.db
      .insert(productImagesTable)
      .values({
        productId,
        variantId: dto.variantId ?? null,
        key: dto.key,
        url: this.storageService.getPublicUrl(dto.key),
        position: maxPosition + 1,
      })
      .returning();

    return toProductImage(row);
  }

  async reorderImages(
    productId: number,
    accountId: number,
    dto: ReorderProductImagesDto,
  ): Promise<ProductImage[] | undefined> {
    if (!(await this.productExists(productId, accountId))) return undefined;

    await this.db.transaction(async (tx) => {
      for (const [index, imageId] of dto.imageIds.entries()) {
        await tx
          .update(productImagesTable)
          .set({ position: index })
          .where(
            and(
              eq(productImagesTable.id, imageId),
              eq(productImagesTable.productId, productId),
            ),
          );
      }
    });

    const rows = await this.db
      .select()
      .from(productImagesTable)
      .where(
        and(
          eq(productImagesTable.productId, productId),
          inArray(productImagesTable.id, dto.imageIds),
        ),
      )
      .orderBy(productImagesTable.position);

    return rows.map(toProductImage);
  }

  async removeImage(
    productId: number,
    accountId: number,
    imageId: number,
  ): Promise<ProductImage | undefined> {
    if (!(await this.productExists(productId, accountId))) return undefined;

    const [row] = await this.db
      .delete(productImagesTable)
      .where(
        and(
          eq(productImagesTable.id, imageId),
          eq(productImagesTable.productId, productId),
        ),
      )
      .returning();
    if (!row) return undefined;

    await this.storageService.deleteObject(row.key);
    return toProductImage(row);
  }
}
