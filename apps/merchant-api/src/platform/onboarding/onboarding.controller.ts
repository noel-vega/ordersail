import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';
import { OnboardingService } from './onboarding.service';
import { OnboardingStatus } from './entities/onboarding-status.entity';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  // no @RequirePermissions — parity with GET /dashboard; any authenticated
  // member of the account can see their own onboarding state
  @Get('status')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: OnboardingStatus })
  getStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.onboardingService.getStatus(user.accountId);
  }
}
