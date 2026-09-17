import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CustomerOrdersController } from './customer-orders.controller';
import { CustomerOrdersService } from './customer-orders.service';
import { CustomerAuthGuard } from '../auth.guard';
import type { AuthenticatedCustomer } from '../auth.decorators';

const customer: AuthenticatedCustomer = {
  sub: 7,
  accountId: 42,
  email: 'shopper@buyer.test',
  firstName: 'Shopper',
  lastName: 'Buyer',
  typ: 'access',
};

describe('CustomerOrdersController', () => {
  let controller: CustomerOrdersController;
  let service: { findAll: jest.Mock; findOne: jest.Mock };

  beforeEach(async () => {
    service = { findAll: jest.fn(), findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CustomerOrdersController],
      providers: [{ provide: CustomerOrdersService, useValue: service }],
    })
      .overrideGuard(CustomerAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(CustomerOrdersController);
  });

  it('is guarded by CustomerAuthGuard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      CustomerOrdersController,
    ) as unknown[];
    expect(guards).toContain(CustomerAuthGuard);
  });

  it('findAll scopes to the token customer and account', async () => {
    await controller.findAll({ limit: 20, offset: 0 }, customer);

    expect(service.findAll).toHaveBeenCalledWith(
      { limit: 20, offset: 0 },
      7,
      42,
    );
  });

  it('findOne scopes to the token customer and account', async () => {
    service.findOne.mockResolvedValue({ id: 5 });

    await expect(controller.findOne(5, customer)).resolves.toEqual({ id: 5 });
    expect(service.findOne).toHaveBeenCalledWith(5, 7, 42);
  });

  it('findOne throws NotFoundException when the order is not theirs', async () => {
    service.findOne.mockResolvedValue(undefined);

    await expect(controller.findOne(5, customer)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
