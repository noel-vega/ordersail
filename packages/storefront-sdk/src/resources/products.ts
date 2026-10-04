import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import { unwrap, unwrapOrUndefinedOn } from "../http.js";

export function createProductsResource(client: Client<paths>) {
  return {
    // no legitimate "empty" case for a list — any non-2xx is a real failure
    list: async (
      query: paths["/v1/products"]["get"]["parameters"]["query"] = {},
    ) => {
      const result = await client.GET("/v1/products", { params: { query } });
      return unwrap(result);
    },

    getById: async (id: number) => {
      const path: paths["/v1/products/{id}"]["get"]["parameters"]["path"] = {
        id: String(id),
      };
      const result = await client.GET("/v1/products/{id}", { params: { path } });
      return unwrapOrUndefinedOn(result, 404);
    },
  };
}
