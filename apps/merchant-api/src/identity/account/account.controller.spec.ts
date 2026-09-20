import { ForbiddenException } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import type { AuthenticatedUser } from 'src/shared/auth/decorators';

const user: AuthenticatedUser = {
  sub: 1,
  accountId: 1,
  emailVerified: true,
  mfaEnrollmentSatisfied: true,
  typ: 'access',
};

function build() {
  // kept as a plain jest.fn(), not cast to AccountService, so assertions
  // below reference an ordinary mock rather than an "unbound class method"
  const update = jest.fn().mockResolvedValue({ id: 1 });
  const controller = new AccountController({
    update,
  } as unknown as AccountService);
  return { controller, update };
}

// The requireMfa field needs account:manage_security on top of the
// account:write @RequirePermissions() gate on the whole route — this
// in-handler check (OS-473) is the only thing enforcing that, so it's
// tested directly against the controller rather than via guard metadata.
describe('AccountController.update — requireMfa authorization (OS-473)', () => {
  it('allows an ordinary field edit with only account:write', async () => {
    const { controller, update } = build();
    await controller.update(
      { phone: '5555551234' },
      user,
      new Set(['account:write']),
    );
    expect(update).toHaveBeenCalledWith(1, { phone: '5555551234' });
  });

  it('rejects toggling requireMfa without account:manage_security', () => {
    const { controller } = build();
    expect(() =>
      controller.update({ requireMfa: true }, user, new Set(['account:write'])),
    ).toThrow(ForbiddenException);
  });

  it('allows toggling requireMfa with account:manage_security', async () => {
    const { controller, update } = build();
    await controller.update(
      { requireMfa: true },
      user,
      new Set(['account:write', 'account:manage_security']),
    );
    expect(update).toHaveBeenCalledWith(1, { requireMfa: true });
  });

  it('rejects even when granted is undefined (no @RequirePermissions() context)', () => {
    const { controller } = build();
    expect(() =>
      controller.update({ requireMfa: false }, user, undefined),
    ).toThrow(ForbiddenException);
  });
});
