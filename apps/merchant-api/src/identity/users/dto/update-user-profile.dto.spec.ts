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

  it('accepts a formatted number with an extension', async () => {
    const errors = await errorsFor({ phone: '+1 (555) 555-0100 ext. 4421' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a phone longer than the cap', async () => {
    const errors = await errorsFor({ phone: '5'.repeat(33) });
    expect(errors.some((e) => e.property === 'phone')).toBe(true);
  });

  it('rejects a phone that is not a string', async () => {
    const errors = await errorsFor({ phone: 5555550100 });
    expect(errors.some((e) => e.property === 'phone')).toBe(true);
  });
});
