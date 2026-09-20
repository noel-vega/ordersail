import { ApiProperty } from '@nestjs/swagger';

export class OnboardingLinkResponse {
  // single-use and short-lived — redirect to it immediately, never store it
  @ApiProperty()
  url!: string;
}
