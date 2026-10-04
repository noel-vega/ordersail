import { HttpException } from '@nestjs/common';
import { codes, type DetailsByCode, type ErrorCode } from './codes.ts';

// `details` is required for a code whose DetailsByCode entry is required,
// optional for one whose entry is optional, and not allowed otherwise.
type DetailsOption<C extends ErrorCode> = C extends keyof DetailsByCode
  ? undefined extends DetailsByCode[C]
    ? { details?: DetailsByCode[C] }
    : { details: DetailsByCode[C] }
  : { details?: never };

export type ApiExceptionOptions<C extends ErrorCode> = {
  // overrides the registry's default message (ignored on a 5xx, which is always
  // generic)
  message?: string;
  // the request field that caused the error
  param?: string;
} & DetailsOption<C>;

type OptionsArgs<C extends ErrorCode> =
  {} extends ApiExceptionOptions<C>
    ? [options?: ApiExceptionOptions<C>]
    : [options: ApiExceptionOptions<C>];

// The exception for an error with a registry code. The status comes from the
// registry, so a throw site names only the reason:
//
//   throw new ApiException('email_taken', { param: 'email' });
//   throw new ApiException('validation_failed', { details: { fields } });
//
// It's an HttpException, so anything that already handles those (guards,
// interceptors, LoggingExceptionFilter) keeps working.
export class ApiException<C extends ErrorCode = ErrorCode> extends HttpException {
  readonly code: C;
  readonly param: string | undefined;
  readonly details: unknown;

  constructor(code: C, ...[options]: OptionsArgs<C>) {
    const entry = codes[code];
    const message = options?.message ?? entry.message;
    super({ code, message, param: options?.param, details: options?.details }, entry.status);
    this.code = code;
    this.param = options?.param;
    this.details = options?.details;
  }
}
