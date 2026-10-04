import type { ValidationError } from 'class-validator';
import { ApiException } from './api-exception.ts';
import type { FieldError } from './codes.ts';

// The ValidationPipe exceptionFactory: every failed DTO becomes one
// `validation_failed` error. `param` and `message` describe the first failure
// (as Stripe does) and `details.fields` lists all of them, so a form can mark
// every field at once. Nested properties become dotted paths
// (`shippingDetails.address.postal_code`; array items by index, `items.0.sku`).
export function validationExceptionFactory(errors: ValidationError[]): ApiException<'validation_failed'> {
  const fields = flatten(errors);
  const [first] = fields;
  return new ApiException('validation_failed', {
    message: first?.message,
    param: first?.param,
    details: { fields },
  });
}

function flatten(errors: ValidationError[], parent?: string): FieldError[] {
  return errors.flatMap((error) => {
    const param = parent === undefined ? error.property : `${parent}.${error.property}`;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ param, message }));
    return [...own, ...flatten(error.children ?? [], param)];
  });
}
