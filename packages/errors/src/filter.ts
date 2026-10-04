import type { ArgumentsHost, ExceptionFilter, HttpServer } from '@nestjs/common';
import { getCorrelationId, logHttpException } from 'logging';
import { toErrorEnvelope } from './envelope.ts';

// The global HTTP exception filter (registered by useApiErrors). Logs the
// exception exactly as LoggingExceptionFilter does — same events, same levels —
// then answers with the error envelope through the HTTP adapter, so Express and
// Fastify behave the same. It never hands off to Nest's BaseExceptionFilter:
// that would send Nest's own body and log a second, unstructured line.
export class ApiErrorFilter implements ExceptionFilter {
  readonly #httpAdapter: HttpServer;

  constructor(httpAdapter: HttpServer) {
    this.#httpAdapter = httpAdapter;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    // the APIs only serve HTTP; anything else is a wiring mistake, so don't
    // swallow it
    if (host.getType() !== 'http') throw exception;

    const { status, body } = toErrorEnvelope(exception, getCorrelationId());
    // log with the status the client gets, so an untrusted error with a
    // statusCode (answered as a 500) logs as an unhandled error
    logHttpException(exception, host, status);
    const response = host.getArgByIndex(1);
    // a response that already started streaming can't take a new status or
    // body; end it so the client isn't left hanging
    if (this.#httpAdapter.isHeadersSent(response)) {
      this.#httpAdapter.end(response);
      return;
    }
    this.#httpAdapter.reply(response, body, status);
  }
}
