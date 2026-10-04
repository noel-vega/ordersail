import { configureLogging } from './index.ts';

// Routes the shared root into memory and returns the parsed lines. Specs only;
// exported as `logging/test-helpers` for other packages' specs (packages/tracing).
export function captureLogs(): Record<string, any>[] {
  const lines: Record<string, any>[] = [];
  configureLogging({
    service: 'test',
    nodeEnv: 'production',
    destination: { write: (chunk: string) => void lines.push(JSON.parse(chunk)) },
  });
  return lines;
}
