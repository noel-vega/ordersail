// DI token for the Shippo client, so tests can swap it with `useValue` (same
// pattern as DRIZZLE, and as storefront-api's checkout SHIPPO). The real
// client is built in fulfillments.module.ts.
export const SHIPPO = Symbol('SHIPPO');
