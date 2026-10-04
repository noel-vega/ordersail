import { HttpException } from '@nestjs/common';
import { httpErrorOf } from 'logging';
import { ApiException } from './api-exception.ts';
import {
  codes,
  docUrl,
  genericCodeForStatus,
  isErrorCode,
  typeForStatus,
  type ErrorCode,
  type ErrorType,
} from './codes.ts';

// The one error body every API returns (docs/adr/0001-api-error-envelope.md).
export type ErrorEnvelope = {
  error: {
    type: ErrorType;
    code: ErrorCode;
    message: string;
    param?: string;
    doc_url: string;
    // null only outside a request's log context
    request_id: string | null;
    details?: unknown;
  };
};

type Resolved = {
  status: number;
  code: ErrorCode;
  message?: string;
  param?: string;
  details?: unknown;
};

// Maps anything a handler can throw to the status and body to send. Pure: the
// filter supplies the request ID and does the logging and the reply.
//
// A 5xx always gets its code's generic message and no internals (thrown text,
// stack, cause), whatever was thrown. A 4xx keeps the message it was thrown with.
export function toErrorEnvelope(
  exception: unknown,
  requestId: string | undefined,
): { status: number; body: ErrorEnvelope } {
  const { status, code, message, param, details } = resolve(exception);
  const safeMessage = status >= 500 || !message ? codes[code].message : message;
  return {
    status,
    body: {
      error: {
        type: typeForStatus(status),
        code,
        message: safeMessage,
        ...(param === undefined ? {} : { param }),
        doc_url: docUrl(code),
        request_id: requestId ?? null,
        ...(details === undefined ? {} : { details }),
      },
    },
  };
}

function resolve(exception: unknown): Resolved {
  if (exception instanceof ApiException) {
    return {
      status: exception.getStatus(),
      code: exception.code,
      message: exception.message,
      param: exception.param,
      details: exception.details,
    };
  }
  if (exception instanceof HttpException) return fromHttpException(exception);

  // http-errors from Express's body parser and Fastify's FST_ERR_* errors
  // (malformed JSON 400, 413, 415) carry their own status
  const httpError = httpErrorOf(exception);
  if (httpError && httpError.statusCode >= 400 && httpError.statusCode <= 599) {
    return {
      status: httpError.statusCode,
      code: genericCodeForStatus(httpError.statusCode),
      message: httpError.message,
    };
  }

  return { status: 500, code: 'internal_error' };
}

function fromHttpException(exception: HttpException): Resolved {
  const status = exception.getStatus();
  const response = exception.getResponse();

  const health = healthDetailsOf(status, response);
  if (health) return { status, code: 'service_unavailable', details: health };

  return {
    status,
    code: payloadCodeOf(status, response) ?? genericCodeForStatus(status),
    message: messageOf(response, exception),
  };
}

// A hand-rolled `{ message, code }` payload (MFA_FACTOR_REQUIRED) keeps its code
// once it's snake_cased, but only if the registry has it for this status: the
// registry is the only definition of the codes, and an unregistered one would be
// missing from the OpenAPI enum and the SDKs' ErrorCode union.
function payloadCodeOf(status: number, response: unknown): ErrorCode | undefined {
  if (!isRecord(response) || typeof response.code !== 'string') return undefined;
  const code = toSnakeCase(response.code);
  return isErrorCode(code) && codes[code].status === status ? code : undefined;
}

// Nest puts the thrown message in the response object; the old ValidationPipe
// (and BadRequestException(string[])) sends an array, which the SDKs joined.
function messageOf(response: unknown, exception: HttpException): string | undefined {
  if (typeof response === 'string') return response;
  if (isRecord(response)) {
    if (typeof response.message === 'string') return response.message;
    if (Array.isArray(response.message) && response.message.every((item) => typeof item === 'string')) {
      return response.message.join(', ');
    }
  }
  return exception.message || undefined;
}

// Terminus throws ServiceUnavailableException({ status: 'error', info, error,
// details }) when a check is down. `details` keeps only up/down per check: the
// indicators' own text (a driver error with a host and port) stays in the logs.
function healthDetailsOf(status: number, response: unknown): Record<string, 'up' | 'down'> | undefined {
  if (status !== 503 || !isRecord(response) || response.status !== 'error' || !isRecord(response.details)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(response.details).map(([check, result]) => [
      check,
      isRecord(result) && result.status === 'up' ? 'up' : 'down',
    ]),
  );
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
