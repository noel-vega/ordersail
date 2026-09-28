import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLocationDto } from './create-location.dto';
import { UpdateLocationDto } from './update-location.dto';

// plainToInstance is the transform half of the ValidationPipe, validate() the
// half that turns a failure into a 400. Both location DTOs inherit the phone
// from ShipFromDto, so each case runs against both.
describe.each([
  ['CreateLocationDto', CreateLocationDto, { name: 'Hoboken Warehouse' }],
  ['UpdateLocationDto', UpdateLocationDto, {}],
] as const)('%s phone (OS-688)', (_, Dto, base) => {
  const parse = (body: object) => plainToInstance(Dto, { ...base, ...body });

  it('stores the E.164 form of a formatted number', async () => {
    const dto = parse({ phone: '+1 (201) 555-0123' });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.phone).toBe('+12015550123');
  });

  it('accepts null, which clears it', async () => {
    const dto = parse({ phone: null });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.phone).toBeNull();
  });

  it('keeps an absent phone absent', async () => {
    const dto = parse({ addressCity: 'Hoboken' });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.phone).toBeUndefined();
  });

  it.each(['asdf', '2015550123', '+15555550100', ''])(
    'rejects %p',
    async (phone) => {
      const errors = await validate(parse({ phone }));
      expect(errors.map((e) => e.property)).toEqual(['phone']);
    },
  );
});
