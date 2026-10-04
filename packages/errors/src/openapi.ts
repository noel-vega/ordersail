import { codes, ERROR_TYPES } from './codes.ts';

// The slice of an OpenAPI 3.0 document this touches. Structural, so it takes
// @nestjs/swagger's OpenAPIObject (or any other generator's) without depending
// on it.
type OpenApiDocument = {
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

// The ErrorResponse schema, its enums generated from the registry. `details`
// is any object for now; per-code schemas come with the registry's JSON Schemas.
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
          details: { type: 'object', additionalProperties: true },
        },
      },
    },
  };
}

// Post-processes a generated document (run on SwaggerModule.createDocument's
// output) so every error response is described:
// - adds components.schemas.ErrorResponse;
// - gives every 4xx/5xx response that has no content the ErrorResponse body
//   (one that already has content — Terminus's /health 503 — is left alone);
// - adds a `default` error response to every operation.
// Returns a new document; the input is not modified.
export function withErrorResponses<T extends OpenApiDocument>(document: T): T {
  const result = structuredClone(document);
  result.components = {
    ...result.components,
    schemas: { ...result.components?.schemas, ErrorResponse: errorResponseSchema() },
  };

  for (const pathItem of Object.values(result.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as Operation | undefined;
      if (!operation) continue;
      const responses = (operation.responses ??= {});
      for (const [status, response] of Object.entries(responses)) {
        if (/^[45](\d\d|XX)$/.test(status) && !response.content) response.content = errorContent();
      }
      responses.default ??= { description: 'Error', content: errorContent() };
    }
  }
  return result;
}
