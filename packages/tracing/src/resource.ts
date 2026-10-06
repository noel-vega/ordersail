import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';

// What every signal from a service says about where it came from: traces
// (index.ts) and metrics (packages/metrics). A subpath of its own, like
// logging/span-attributes, so packages/metrics can share it without loading
// this package's main entry and its instrumentations. Imports nothing else.
export function serviceResource(service: string): Resource {
  return resourceFromAttributes({
    // the same value as the Loki `service_name` label
    'service.name': service,
    'deployment.environment': process.env.NODE_ENV ?? 'development',
  });
}
