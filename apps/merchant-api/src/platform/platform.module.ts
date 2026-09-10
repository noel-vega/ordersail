import { Module } from '@nestjs/common';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { PosDevicesModule } from './pos-devices/pos-devices.module';

// Platform: the cross-context dashboard read-model, the onboarding-status
// read-model, the health probe, and POS device pairing. `dashboard` and
// `onboarding` are allowed to read across contexts.
@Module({
  imports: [DashboardModule, HealthModule, OnboardingModule, PosDevicesModule],
})
export class PlatformModule {}
