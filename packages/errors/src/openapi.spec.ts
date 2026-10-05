import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { codes } from './codes.ts';
import { withErrorResponses } from './openapi.ts';

const healthContent = { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } };

function document() {
  return {
    openapi: '3.0.0',
    paths: {
      '/products/{id}': {
        get: { responses: { '200': { description: '' }, '404': { description: '' } } },
        parameters: [],
      },
      '/auth/sign-in': { post: { responses: { '201': { description: '' }, '401': { description: 'Bad credentials' } } } },
      '/health': { get: { responses: { '200': { description: '' }, '503': { description: 'down', content: healthContent } } } },
    },
    components: { schemas: { SignInDto: { type: 'object' } } },
  };
}

const errorContent = { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } };

describe('withErrorResponses', () => {
  it('adds the ErrorResponse component next to the existing schemas', () => {
    const result = withErrorResponses(document()) as any;
    assert.ok(result.components.schemas.SignInDto);
    assert.ok(result.components.schemas.ErrorResponse);
  });

  it("generates the code enum from the registry", () => {
    const schema = (withErrorResponses(document()) as any).components.schemas.ErrorResponse;
    assert.deepEqual(schema.properties.error.properties.code.enum, Object.keys(codes));
  });

  it('gives every error response the ErrorResponse body, and leaves success responses alone', () => {
    const { paths } = withErrorResponses(document()) as any;
    assert.deepEqual(paths['/products/{id}'].get.responses['404'].content, errorContent);
    assert.equal(paths['/auth/sign-in'].post.responses['401'].description, 'Bad credentials');
    assert.deepEqual(paths['/auth/sign-in'].post.responses['401'].content, errorContent);
    assert.equal(paths['/products/{id}'].get.responses['200'].content, undefined, 'success responses untouched');
    assert.deepEqual(paths['/health'].get.responses['503'].content, errorContent, "Terminus's 503 replaced");
    assert.equal(paths['/health'].get.responses['503'].description, 'down', 'its description kept');
  });

  it('adds a default error response to every operation', () => {
    const { paths } = withErrorResponses(document()) as any;
    for (const op of [paths['/products/{id}'].get, paths['/auth/sign-in'].post, paths['/health'].get]) {
      assert.deepEqual(op.responses.default, { description: 'Error', content: errorContent });
    }
  });

  it('gives every response its own content object, shared with nothing else', () => {
    const first = withErrorResponses(document()) as any;
    const notFound = first.paths['/products/{id}'].get.responses['404'];
    notFound.content['application/json'].schema = { type: 'string' };
    assert.deepEqual(first.paths['/auth/sign-in'].post.responses['401'].content, errorContent);
    assert.deepEqual(first.paths['/products/{id}'].get.responses.default.content, errorContent);
    const second = withErrorResponses(document()) as any;
    assert.deepEqual(second.paths['/products/{id}'].get.responses['404'].content, errorContent);
  });

  it("doesn't modify its input", () => {
    const input = document();
    const before = JSON.stringify(input);
    withErrorResponses(input);
    assert.equal(JSON.stringify(input), before);
  });
});
