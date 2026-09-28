import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  insertAccount,
  insertLocation,
  insertOrder,
  insertOrderItem,
  insertOrderShipping,
  useTestDb,
} from 'test-support';
import { DRIZZLE } from 'src/shared/database/database.constants';
import { OrdersService } from '../orders/orders.service';
import { FulfillmentsService } from './fulfillments.service';

// the Shippo client is a module-level singleton, so it is swapped out here
const mockCreateShipment = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('./shippo.client', () => ({
  shippo: {
    shipments: { create: (...args: unknown[]) => mockCreateShipment(...args) },
  },
}));

const db = useTestDb();

async function build() {
  const ref = await Test.createTestingModule({
    providers: [
      FulfillmentsService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: OrdersService,
        useValue: {
          getFulfilledQuantityByItem: () => Promise.resolve(new Map()),
        },
      },
    ],
  }).compile();
  return ref.get(FulfillmentsService);
}

async function seedOrder(opts: { phone: string | null }) {
  const account = await insertAccount(db);
  const location = await insertLocation(db, {
    accountId: account.id,
    name: 'Hoboken Warehouse',
    phone: opts.phone,
  });
  const order = await insertOrder(db, { accountId: account.id });
  const item = await insertOrderItem(db, { orderId: order.id });
  await insertOrderShipping(db, { orderId: order.id });
  return {
    accountId: account.id,
    dto: {
      orderId: order.id,
      locationId: location.id,
      items: [{ orderItemId: item.id, quantity: 1 }],
    },
  };
}

beforeEach(() => mockCreateShipment.mockReset());

// USPS won't quote a label without a contact phone at the origin, and that
// phone now belongs to the ship-from location, not the account (OS-688)
describe('FulfillmentsService.getRates — ship-from phone (OS-688)', () => {
  it('refuses a location with no phone, naming it, before calling Shippo', async () => {
    const { accountId, dto } = await seedOrder({ phone: null });
    const service = await build();

    const attempt = service.getRates(dto, accountId);
    await expect(attempt).rejects.toThrow(BadRequestException);
    await expect(attempt).rejects.toThrow(
      'Add a phone number to Hoboken Warehouse before buying a label',
    );
    expect(mockCreateShipment).not.toHaveBeenCalled();
  });

  it("sends the location's phone as the origin contact", async () => {
    const { accountId, dto } = await seedOrder({ phone: '+12015550123' });
    mockCreateShipment.mockResolvedValue({
      rates: [
        {
          objectId: 'rate_1',
          provider: 'USPS',
          servicelevel: { name: 'Ground Advantage' },
          amount: '5.10',
          estimatedDays: 3,
        },
      ],
    });
    const service = await build();

    const rates = await service.getRates(dto, accountId);

    expect(rates).toHaveLength(1);
    const [shipment] = mockCreateShipment.mock.calls[0] as [
      { addressFrom: { name: string; phone?: string } },
    ];
    expect(shipment.addressFrom).toMatchObject({
      name: 'Hoboken Warehouse',
      phone: '+12015550123',
    });
  });
});
