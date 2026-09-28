import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateUserProfileDto } from './update-user-profile.dto';

async function errorsFor(body: Record<string, unknown>) {
  return validate(plainToInstance(UpdateUserProfileDto, body));
}

// UsersService.update() tells "leave the phone alone" (absent) from "clear
// it" (null or blank), and that only works if validation lets all three
// through as they arrived. Nothing else pins that: @IsOptional() skipping
// null is class-validator behaviour this DTO silently leans on.
describe('UpdateUserProfileDto phone (OS-503)', () => {
  it('accepts null, which is how a form says "I no longer have one"', async () => {
    const errors = await errorsFor({ phone: null });
    expect(errors).toHaveLength(0);
  });

  it('accepts a blank string, which the service also treats as a clear', async () => {
    const errors = await errorsFor({ phone: '' });
    expect(errors).toHaveLength(0);
  });

  it('keeps an absent phone absent rather than defaulting it', async () => {
    const dto = plainToInstance(UpdateUserProfileDto, { firstName: 'Dana' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.phone).toBeUndefined();
  });

  it('stores a formatted international number as E.164 (OS-687)', async () => {
    const dto = plainToInstance(UpdateUserProfileDto, {
      phone: '+1 (201) 555-0100',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.phone).toBe('+12015550100');
  });

  it.each(['asdf', '2015550100', '+1 201-555-0100 ext. 4421'])(
    'rejects %p, which is not an international number (OS-687)',
    async (phone) => {
      const errors = await errorsFor({ phone });
      expect(errors.some((e) => e.property === 'phone')).toBe(true);
    },
  );

  it('rejects a phone that is not a string', async () => {
    const errors = await errorsFor({ phone: 12015550100 });
    expect(errors.some((e) => e.property === 'phone')).toBe(true);
  });
});
