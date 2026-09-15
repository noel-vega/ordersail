import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { ProductsService } from '../products/products.service';

describe('BrandsController', () => {
  let controller: BrandsController;
  let brandsService: { findAll: jest.Mock; findOne: jest.Mock };
  let productsService: { findAll: jest.Mock };

  beforeEach(async () => {
    brandsService = { findAll: jest.fn(), findOne: jest.fn() };
    productsService = { findAll: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BrandsController],
      providers: [
        { provide: BrandsService, useValue: brandsService },
        { provide: ProductsService, useValue: productsService },
      ],
    }).compile();

    controller = module.get<BrandsController>(BrandsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('findOne throws NotFoundException when the brand is not found', async () => {
    brandsService.findOne.mockResolvedValue(undefined);

    await expect(
      controller.findOne('1', { limit: 20, offset: 0 }, 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(productsService.findAll).not.toHaveBeenCalled();
  });

  it('findOne returns the brand with its products, filtered by brandId', async () => {
    brandsService.findOne.mockResolvedValue({ id: 1, name: 'Acme' });
    const products = { items: [], total: 0, limit: 20, offset: 0 };
    productsService.findAll.mockResolvedValue(products);

    const result = await controller.findOne('1', { limit: 20, offset: 0 }, 42);

    expect(productsService.findAll).toHaveBeenCalledWith(
      { limit: 20, offset: 0, brandId: 1 },
      42,
    );
    expect(result).toEqual({ id: 1, name: 'Acme', products });
  });
});
