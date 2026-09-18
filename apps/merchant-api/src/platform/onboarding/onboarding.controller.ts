import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import {
  AuthenticatedOnly,
  CurrentUser,
  type AuthenticatedUser,
  NoMfaFactorRequired,
} from 'src/shared/auth/decorators';
import { OnboardingService } from './onboarding.service';
import { OnboardingStatus } from './entities/onboarding-status.entity';

@Controller('onboarding')
@NoMfaFactorRequired()
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  // any authenticated member of the account can see their own onboarding
  // state — it backs the ungated home page, not the (now gated) dashboard
  @AuthenticatedOnly()
  @Get('status')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: OnboardingStatus })
  getStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.onboardingService.getStatus(user.accountId);
  }
}
