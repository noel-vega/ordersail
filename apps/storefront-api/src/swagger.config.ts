import { DocumentBuilder } from '@nestjs/swagger';

// Servers are bare hosts: the /v1 version lives in each path, not here
// (OS-714). Without them, a renderer (Scalar on ordersail.com/docs/api)
// resolves paths against the docs site's own origin. Production is listed
// first so it's the default.
export function createSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle('Storefront')
    .setVersion('1.0')
    .addServer('https://storefront.ordersail.com', 'Production')
    .addServer('http://localhost:3001', 'Local development')
    .addApiKey(
      { type: 'apiKey', name: 'x-app-key', in: 'header' },
      'AppKey-auth',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'CustomerJWT-auth',
    )
    .build();
}
