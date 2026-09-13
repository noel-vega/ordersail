import type { Client } from "openapi-fetch";
import type { components, paths } from "../types.gen.js";
import { unwrap, unwrapOrUndefinedOn, type DoFn } from "../http.js";

export function createCustomerResource(client: Client<paths>, doRequest: DoFn) {
  return {
    // 401 = not currently signed in (the everyday case) — a lingering 401
    // after do()'s refresh-and-retry means truly not authenticated. A 404
    // here would mean the customer row is missing despite a valid JWT, an
    // anomaly worth throwing on rather than swallowing.
    get: async () => {
      const result = await doRequest(() => client.GET("/customer"));
      return unwrapOrUndefinedOn(result, 401);
    },

    update: async (params: components["schemas"]["UpdateCustomerDto"]) => {
      const result = await doRequest(() =>
        client.PATCH("/customer", { body: params }),
      );
      return unwrap(result);
    },
  };
}
