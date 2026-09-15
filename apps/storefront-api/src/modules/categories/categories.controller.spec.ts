import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { ProductsService } from '../products/products.service';

describe('CategoriesController', () => {
  let controller: CategoriesController;
  let categoriesService: { findAll: jest.Mock; findOne: jest.Mock };
  let productsService: { findAll: jest.Mock };

  beforeEach(async () => {
    categoriesService = { findAll: jest.fn(), findOne: jest.fn() };
    productsService = { findAll: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CategoriesController],
      providers: [
        { provide: CategoriesService, useValue: categoriesService },
        { provide: ProductsService, useValue: productsService },
      ],
    }).compile();

    controller = module.get<CategoriesController>(CategoriesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('findOne throws NotFoundException when the category is not found', async () => {
    categoriesService.findOne.mockResolvedValue(undefined);

    await expect(
      controller.findOne('1', { limit: 20, offset: 0 }, 42),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(productsService.findAll).not.toHaveBeenCalled();
  });

  it('findOne returns the category with its products, filtered by categoryId', async () => {
    categoriesService.findOne.mockResolvedValue({ id: 1, name: 'Shoes' });
    const products = { items: [], total: 0, limit: 20, offset: 0 };
    productsService.findAll.mockResolvedValue(products);

    const result = await controller.findOne('1', { limit: 20, offset: 0 }, 42);

    expect(productsService.findAll).toHaveBeenCalledWith(
      { limit: 20, offset: 0, categoryId: 1 },
      42,
    );
    expect(result).toEqual({ id: 1, name: 'Shoes', products });
  });
});
