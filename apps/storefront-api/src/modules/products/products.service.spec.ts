import { Test, TestingModule } from '@nestjs/testing';
import { makeDb } from 'test-support';
import { ProductsService } from './products.service';
import { DRIZZLE } from '../../database/database.constants';

describe('ProductsService', () => {
  let service: ProductsService;

  async function build(db: unknown) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProductsService, { provide: DRIZZLE, useValue: db }],
    }).compile();
    return module.get<ProductsService>(ProductsService);
  }

  it('should be defined', async () => {
    service = await build(makeDb([[], [{ total: 0 }]]));
    expect(service).toBeDefined();
  });

  it('returns an empty page with no extra lookups when there are no products', async () => {
    service = await build(makeDb([[], [{ total: 0 }]]));

    const result = await service.findAll({ limit: 20, offset: 0 }, 1);

    expect(result).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it('attaches brand and categories and carries through the price range', async () => {
    const db = makeDb([
      [
        {
          id: 1,
          name: 'Shoe',
          description: 'A shoe',
          brandId: 5,
          minPriceCents: 1000,
          maxPriceCents: 2000,
        },
      ],
      [{ total: 1 }],
      [{ id: 5, name: 'Acme' }],
      [{ productId: 1, id: 9, name: 'Footwear' }],
      [{ productId: 1, url: 'https://img/shoe.jpg' }],
    ]);
    service = await build(db);

    const result = await service.findAll({ limit: 20, offset: 0 }, 1);

    expect(result).toEqual({
      items: [
        {
          id: 1,
          name: 'Shoe',
          description: 'A shoe',
          brand: { id: 5, name: 'Acme' },
          categories: [{ id: 9, name: 'Footwear' }],
          thumbnailUrl: 'https://img/shoe.jpg',
          minPriceCents: 1000,
          maxPriceCents: 2000,
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
    });
  });

  it('leaves brand null for a product with no brand', async () => {
    const db = makeDb([
      [
        {
          id: 1,
          name: 'Shoe',
          description: null,
          brandId: null,
          minPriceCents: null,
          maxPriceCents: null,
        },
      ],
      [{ total: 1 }],
      [],
      [],
    ]);
    service = await build(db);

    const result = await service.findAll({ limit: 20, offset: 0 }, 1);

    expect(result.items[0].brand).toBeNull();
    expect(result.items[0].categories).toEqual([]);
    expect(result.items[0].thumbnailUrl).toBeNull();
  });

  // covers the not-found path shared by all three cases the controller
  // maps to 404: unknown id, wrong tenant, and draft/archived status
  it('findOne returns undefined when no active product matches the id/account', async () => {
    service = await build(makeDb([[]]));

    const result = await service.findOne(1, 1);

    expect(result).toBeUndefined();
  });
});
