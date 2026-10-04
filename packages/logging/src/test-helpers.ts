import type { IncomingMessage } from 'node:http';
import type { ArgumentsHost } from '@nestjs/common';
import { configureLogging, setRequestRoute, type LogLevel } from './index.ts';

// Routes the shared root into memory and returns the parsed lines. Specs only;
// exported as `logging/test-helpers` for other packages' specs (packages/tracing,
// packages/errors).
// `level` lowers the threshold (e.g. 'debug' to see rejected 4xx lines).
export function captureLogs(options: { level?: LogLevel } = {}): Record<string, any>[] {
  const lines: Record<string, any>[] = [];
  configureLogging({
    service: 'test',
    nodeEnv: 'production',
    ...(options.level ? { level: options.level } : {}),
    destination: { write: (chunk: string) => void lines.push(JSON.parse(chunk)) },
  });
  return lines;
}

// The slice of Nest's HttpServer adapter an exception filter answers through.
// `headersSent` simulates a response that already started streaming.
export function fakeAdapter(options: { headersSent?: boolean } = {}) {
  const replies: { body: unknown; status: number }[] = [];
  let ended = 0;
  const adapter = {
    reply: (_res: unknown, body: unknown, status: number) => void replies.push({ body, status }),
    isHeadersSent: () => options.headersSent ?? false,
    end: () => void ended++,
  };
  return { adapter: adapter as any, replies, ended: () => ended };
}

// What a filter gets from Nest's Fastify adapter: the Node request under `raw`,
// its route template recorded the way trackRouteTemplates does.
export function fastifyRequest(route: string): { raw: IncomingMessage } {
  const raw = { method: 'GET' } as IncomingMessage;
  setRequestRoute(raw, route);
  return { raw };
}

// An 'http' ArgumentsHost around a fake request (see fastifyRequest).
export function httpHost(request: unknown): ArgumentsHost {
  const response = {};
  return {
    getType: () => 'http',
    getArgByIndex: (index: number) => [request, response][index],
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
}
