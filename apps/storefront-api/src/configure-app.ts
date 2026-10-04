import { INestApplication, ValidationPipe } from '@nestjs/common';

// Every public route lives under /v1 (OS-714). @ordersail/storefront-sdk is on
// public npm, so the version goes in from the start — adding it later would
// break every integrator. The prefix lives in the app, not the edge: the ALB
// can't rewrite paths. Swagger reads it too, so the generated openapi.json
// paths (and the SDK's typed calls) carry /v1 and SDK users only ever set the
// bare host as baseUrl.
const API_PREFIX = 'v1';

// The request handling every storefront-api instance shares — main.ts, the
// OpenAPI generator and the SDK contract spec all build the app through this,
// so the contract under test is exactly the one that ships.
export function configureApp(app: INestApplication): void {
  // /health stays unversioned: it's for the ALB target group, the ECS
  // container check and the deploy smoke tests, not for API consumers.
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
}
