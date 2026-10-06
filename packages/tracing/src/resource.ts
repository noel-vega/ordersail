import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';

// What every signal from a service says about where it came from: traces
// (index.ts) and metrics (packages/metrics). A subpath of its own, like
// logging/span-attributes, so packages/metrics can share it without loading
// this package's main entry and its instrumentations. Imports nothing else.
//
// No `service.version` yet: nothing hands the running image's version to the
// process. That needs an env var through the task definition (the checklist
// in infra/terraform/README.md), and it would go here, for both signals.
export function serviceResource(service: string): Resource {
  return resourceFromAttributes({
    // the same value as the Loki `service_name` label
    'service.name': service,
    'deployment.environment': process.env.NODE_ENV ?? 'development',
  });
}
