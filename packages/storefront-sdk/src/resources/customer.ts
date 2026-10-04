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
      const result = await doRequest(() => client.GET("/v1/customer"));
      return unwrapOrUndefinedOn(result, 401);
    },

    update: async (params: components["schemas"]["UpdateCustomerDto"]) => {
      const result = await doRequest(() =>
        client.PATCH("/v1/customer", { body: params }),
      );
      return unwrap(result);
    },

    // the signed-in customer's order history. Unlike get(), a 401 throws —
    // callers should only reach this once they know someone is signed in
    orders: {
      list: async (
        query: paths["/v1/customer/orders"]["get"]["parameters"]["query"] = {},
      ) => {
        const result = await doRequest(() =>
          client.GET("/v1/customer/orders", { params: { query } }),
        );
        return unwrap(result);
      },

      // undefined on a 404 — no such order, or it belongs to someone else
      // (the API deliberately doesn't distinguish the two)
      getById: async (id: number) => {
        const path: paths["/v1/customer/orders/{id}"]["get"]["parameters"]["path"] =
          { id };
        const result = await doRequest(() =>
          client.GET("/v1/customer/orders/{id}", { params: { path } }),
        );
        return unwrapOrUndefinedOn(result, 404);
      },
    },
  };
}
