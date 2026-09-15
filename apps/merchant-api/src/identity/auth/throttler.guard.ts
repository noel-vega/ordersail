import { Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';

export const THROTTLER_APP_GUARD: Provider = {
  provide: APP_GUARD,
  useClass: ThrottlerGuard,
};
