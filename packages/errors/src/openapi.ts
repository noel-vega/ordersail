import { codes, detailsSchemas, ERROR_TYPES } from './codes.ts';

// Any OpenAPI 3.0 document: @nestjs/swagger's OpenAPIObject or another
// generator's. Kept structural and loose (OpenAPIObject's path items have no
// index signature) so this package doesn't depend on a document generator; the
// slice it touches is read through DocumentSlice below.
type OpenApiDocument = { paths: object; components?: object };

type DocumentSlice = {
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

type Response = { description?: string; content?: Record<string, unknown> };
type Operation = { responses?: Record<string, Response> };

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
// a fresh object per response, so no two responses in the output (or a later
// call's output) share one
function errorContent() {
  return { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } };
}

// The `details` shape of each code that has one, keyed by code. No operation
// references it: one schema per code can't hang off a single `details`
// property in OpenAPI 3.0 without a oneOf variant per code, so clients look a
// code's shape up here instead.
export function errorDetailsByCodeSchema() {
  const entries = Object.entries(detailsSchemas);
  return {
    type: 'object',
    description: "Each error code's `details` shape, keyed by code. A code that isn't listed has no fixed shape.",
    required: entries.filter(([, entry]) => entry.required).map(([code]) => code),
    properties: Object.fromEntries(entries.map(([code, entry]) => [code, structuredClone(entry.schema)])),
  };
}

// The ErrorResponse schema, its enums generated from the registry. `details`
// is any object here; its shape per code is ErrorDetailsByCode.
export function errorResponseSchema() {
  return {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['type', 'code', 'message', 'doc_url', 'request_id'],
        properties: {
          type: { type: 'string', enum: [...ERROR_TYPES] },
          code: { type: 'string', enum: Object.keys(codes) },
          message: { type: 'string', description: 'For people. Never parse it; branch on `code`.' },
          param: { type: 'string', description: 'The request field that caused the error.' },
          doc_url: { type: 'string', format: 'uri' },
          request_id: {
            type: 'string',
            nullable: true,
            description: 'The x-request-id of the request; quote it when reporting a problem.',
          },
          details: {
            type: 'object',
            additionalProperties: true,
            description: 'Extra data for the code; its shape per code is in ErrorDetailsByCode.',
          },
        },
      },
    },
  };
}

// Post-processes a generated document (run on SwaggerModule.createDocument's
// output) so every error response is described:
// - adds components.schemas.ErrorResponse and ErrorDetailsByCode;
// - gives every 4xx/5xx response the ErrorResponse body, replacing whatever a
//   decorator declared: ApiErrorFilter writes the envelope for every error, so
//   any other error schema (Terminus's /health 503) would describe a body the
//   API never sends;
// - adds a `default` error response to every operation.
// Returns a new document; the input is not modified.
export function withErrorResponses<T extends OpenApiDocument>(document: T): T {
  const copy = structuredClone(document);
  const result = copy as unknown as DocumentSlice;
  result.components = {
    ...result.components,
    schemas: {
      ...result.components?.schemas,
      ErrorResponse: errorResponseSchema(),
      ErrorDetailsByCode: errorDetailsByCodeSchema(),
    },
  };

  for (const pathItem of Object.values(result.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as Operation | undefined;
      if (!operation) continue;
      const responses = (operation.responses ??= {});
      for (const [status, response] of Object.entries(responses)) {
        if (/^[45](\d\d|XX)$/.test(status)) response.content = errorContent();
      }
      responses.default ??= { description: 'Error', content: errorContent() };
    }
  }
  return copy;
}
