import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateAccountDto } from './update-account.dto';

// the ValidationPipe runs these same class-validator rules, so a failure
// here is the 400 PATCH /account returns (OS-667)
describe('UpdateAccountDto timezone (OS-667)', () => {
  it('accepts a real IANA zone', async () => {
    const dto = plainToInstance(UpdateAccountDto, {
      timezone: 'America/Chicago',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects an unknown zone', async () => {
    const dto = plainToInstance(UpdateAccountDto, { timezone: 'Mars/Olympus' });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(['timezone']);
  });

  // plainToInstance is the transform half of the ValidationPipe
  it('stores the canonical spelling of an alias', async () => {
    const dto = plainToInstance(UpdateAccountDto, { timezone: 'us/eastern' });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.timezone).toBe('America/New_York');
  });

  it('rejects a bare UTC offset', async () => {
    const dto = plainToInstance(UpdateAccountDto, { timezone: '+05:00' });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(['timezone']);
  });
});

describe('UpdateAccountDto lowStockThreshold (OS-668)', () => {
  it.each([0, 5, 100000])('accepts %p', async (lowStockThreshold) => {
    const dto = plainToInstance(UpdateAccountDto, { lowStockThreshold });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([-1, 1.5, 100001, '5'])('rejects %p', async (lowStockThreshold) => {
    const dto = plainToInstance(UpdateAccountDto, { lowStockThreshold });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(['lowStockThreshold']);
  });
});
