import { ApiProperty } from '@nestjs/swagger';

// What a newly signed-up merchant still has to do before they can take a
// real order. Surfaced as a dashboard checklist (OS-166); nothing is gated
// on `complete` — there is no forced onboarding wall.
export class OnboardingStatus {
  // a stripe_accounts row for the account with charges_enabled = true
  @ApiProperty({ type: Boolean })
  stripeConnected!: boolean;

  // a locations row with a fully-formed ship-from address and a phone — what
  // buying a label from it needs (OS-688). Stricter than the storefront
  // checkout gate (which only needs address_line1) so "done" means the
  // merchant can actually ship.
  @ApiProperty({ type: Boolean })
  hasCompleteLocation!: boolean;

  // a products row with status = 'active' (the value the storefront treats as
  // sellable)
  @ApiProperty({ type: Boolean })
  hasActiveProduct!: boolean;

  @ApiProperty({ type: Boolean })
  complete!: boolean;
}
