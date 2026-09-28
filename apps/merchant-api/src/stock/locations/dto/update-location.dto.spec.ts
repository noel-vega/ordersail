import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateLocationDto } from './update-location.dto';

// plainToInstance is the transform half of the ValidationPipe, validate() the
// half that turns a failure into a 400
describe('UpdateLocationDto phone (OS-688)', () => {
  it('stores the E.164 form of a formatted number', async () => {
    const dto = plainToInstance(UpdateLocationDto, {
      phone: '+1 (201) 555-0123',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.phone).toBe('+12015550123');
  });

  it('accepts null, which clears it', async () => {
    const dto = plainToInstance(UpdateLocationDto, { phone: null });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.phone).toBeNull();
  });

  it('keeps an absent phone absent', async () => {
    const dto = plainToInstance(UpdateLocationDto, { addressCity: 'Hoboken' });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.phone).toBeUndefined();
  });

  it.each(['asdf', '2015550123', '+15555550100', ''])(
    'rejects %p',
    async (phone) => {
      const dto = plainToInstance(UpdateLocationDto, { phone });
      const errors = await validate(dto);
      expect(errors.map((e) => e.property)).toEqual(['phone']);
    },
  );
});
