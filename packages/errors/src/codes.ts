// The error-code registry: the only definition of the codes an API returns
// (docs/adr/0001-api-error-envelope.md). Everything else in this package — the
// exception, the envelope, the OpenAPI schema and through it the SDKs' ErrorCode
// union — derives from it.
//
// It must stay plain data with no framework imports, so that an API rewritten
// outside Node can read it rather than keep its own copy. Adding a code means
// adding one entry here. A code is a public contract once storefront-sdk ships it, so
// renaming or removing one is a breaking change; messages can be reworded.

export const ERROR_TYPES = [
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'rate_limit_error',
  'api_error',
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

export type ErrorCodeEntry = {
  status: number;
  type: ErrorType;
  // the `message` when the thrower gives none; on a 5xx it's the only message
  // a client ever sees
  defaultMessage: string;
};

export const codes = {
  // Generic codes: one per status in the fixed set, named after the RFC 9110
  // reason phrase in snake_case, except 401, 429 and 500 (ADR 0001).
  bad_request: { status: 400, type: 'invalid_request_error', defaultMessage: 'The request is invalid.' },
  unauthenticated: { status: 401, type: 'authentication_error', defaultMessage: 'Authentication is required.' },
  forbidden: { status: 403, type: 'permission_error', defaultMessage: "You don't have permission to do this." },
  not_found: { status: 404, type: 'invalid_request_error', defaultMessage: 'Not found.' },
  method_not_allowed: {
    status: 405,
    type: 'invalid_request_error',
    defaultMessage: 'This method is not allowed here.',
  },
  not_acceptable: {
    status: 406,
    type: 'invalid_request_error',
    defaultMessage: "The requested response format isn't available.",
  },
  request_timeout: { status: 408, type: 'invalid_request_error', defaultMessage: 'The request timed out.' },
  conflict: {
    status: 409,
    type: 'invalid_request_error',
    defaultMessage: 'The request conflicts with the current state of the resource.',
  },
  gone: { status: 410, type: 'invalid_request_error', defaultMessage: 'This resource is no longer available.' },
  precondition_failed: { status: 412, type: 'invalid_request_error', defaultMessage: 'A precondition failed.' },
  content_too_large: { status: 413, type: 'invalid_request_error', defaultMessage: 'The request body is too large.' },
  unsupported_media_type: {
    status: 415,
    type: 'invalid_request_error',
    defaultMessage: "The request's content type isn't supported.",
  },
  misdirected_request: {
    status: 421,
    type: 'invalid_request_error',
    defaultMessage: 'The request was sent to a server that cannot answer it.',
  },
  unprocessable_content: {
    status: 422,
    type: 'invalid_request_error',
    defaultMessage: "The request couldn't be processed.",
  },
  rate_limited: { status: 429, type: 'rate_limit_error', defaultMessage: 'Too many requests. Try again later.' },
  internal_error: { status: 500, type: 'api_error', defaultMessage: 'Something went wrong on our end.' },
  not_implemented: { status: 501, type: 'api_error', defaultMessage: 'This is not implemented.' },
  bad_gateway: { status: 502, type: 'api_error', defaultMessage: 'An upstream service failed.' },
  service_unavailable: { status: 503, type: 'api_error', defaultMessage: 'The service is temporarily unavailable.' },
  gateway_timeout: { status: 504, type: 'api_error', defaultMessage: 'An upstream service timed out.' },
  http_version_not_supported: {
    status: 505,
    type: 'api_error',
    defaultMessage: "The request's HTTP version isn't supported.",
  },

  // Specific codes
  validation_failed: { status: 400, type: 'invalid_request_error', defaultMessage: 'The request has invalid fields.' },
  invalid_access_token: {
    status: 401,
    type: 'authentication_error',
    defaultMessage: 'The access token is missing, invalid or expired.',
  },
  invalid_app_key: { status: 401, type: 'authentication_error', defaultMessage: 'The app key is missing or invalid.' },
  invalid_device_token: {
    status: 401,
    type: 'authentication_error',
    defaultMessage: 'The device token is missing, invalid or revoked.',
  },
  invalid_credentials: {
    status: 401,
    type: 'authentication_error',
    defaultMessage: 'The email or password is incorrect.',
  },
  mfa_factor_required: {
    status: 403,
    type: 'permission_error',
    defaultMessage: 'A passkey or authenticator app is required for this action.',
  },
  email_taken: {
    status: 409,
    type: 'invalid_request_error',
    defaultMessage: 'An account with this email already exists.',
  },
} as const satisfies Record<string, ErrorCodeEntry>;

export type ErrorCode = keyof typeof codes;

// The generic code for each status in the fixed set. A status outside it is a
// bug in the thrower and falls back in genericCodeForStatus.
export const genericCodes: Readonly<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  408: 'request_timeout',
  409: 'conflict',
  410: 'gone',
  412: 'precondition_failed',
  413: 'content_too_large',
  415: 'unsupported_media_type',
  421: 'misdirected_request',
  422: 'unprocessable_content',
  429: 'rate_limited',
  500: 'internal_error',
  501: 'not_implemented',
  502: 'bad_gateway',
  503: 'service_unavailable',
  504: 'gateway_timeout',
  505: 'http_version_not_supported',
};

export type FieldError = { param: string; message: string };

// The shape of `details` for each code that has one, as the throwers in this
// package type it. An optional key means the details are optional.
export interface DetailsByCode {
  // every failing field; nested properties as dotted paths
  validation_failed: { fields: FieldError[] };
  // up/down per health check — never the check's error text (a 5xx body never
  // carries internals; the text is in the logs)
  service_unavailable?: Record<string, 'up' | 'down'>;
}

// The same shapes as data: a JSON Schema per code, `required` when the details
// always come with that code. The OpenAPI document publishes these as
// ErrorDetailsByCode and the SDKs derive their typed `details` from it, so no
// client keeps its own copy. `satisfies` holds the keys and their `required`
// in step with DetailsByCode; keep each schema in step with the type above.
export const detailsSchemas = {
  validation_failed: {
    required: true,
    schema: {
      type: 'object',
      required: ['fields'],
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            required: ['param', 'message'],
            properties: { param: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
    },
  },
  service_unavailable: {
    required: false,
    schema: { type: 'object', additionalProperties: { type: 'string', enum: ['up', 'down'] } },
  },
} as const satisfies {
  [C in keyof DetailsByCode]-?: { required: undefined extends DetailsByCode[C] ? false : true; schema: object };
};

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(codes, value);
}

// Any 4xx without its own category is an invalid request; any 5xx is ours.
export function typeForStatus(status: number): ErrorType {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  return status >= 500 ? 'api_error' : 'invalid_request_error';
}

export function genericCodeForStatus(status: number): ErrorCode {
  return genericCodes[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
}

export function docUrl(code: ErrorCode): string {
  return `https://ordersail.com/docs/errors/${code.replaceAll('_', '-')}`;
}
