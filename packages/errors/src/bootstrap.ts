import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ApiErrorFilter } from './filter.ts';
import { validationExceptionFactory } from './validation.ts';

// The shared error bootstrap for every API's main.ts: the validation pipe
// (same options the APIs use today, plus the envelope's exceptionFactory) and
// the global filter that writes the envelope.
export function useApiErrors(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, exceptionFactory: validationExceptionFactory }),
  );
  app.useGlobalFilters(new ApiErrorFilter(app.getHttpAdapter()));
}
