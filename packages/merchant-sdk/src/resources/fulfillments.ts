import type { Client } from "openapi-fetch";
import type { components, paths } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createFulfillmentsResource(client: Client<paths>, doRequest: DoFn) {
  return {
    getRates: async (params: components["schemas"]["GetFulfillmentRatesDto"]) =>
      unwrap(
        await doRequest(() =>
          client.POST("/fulfillments/rates", { body: params }),
        ),
      ),

    create: async (params: components["schemas"]["CreateFulfillmentDto"]) =>
      unwrap(
        await doRequest(() => client.POST("/fulfillments", { body: params })),
      ),
  };
}
