import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import { unwrap, unwrapOrUndefinedOn } from "../http.js";

export function createBrandsResource(client: Client<paths>) {
  return {
    // no legitimate "empty" case for a list — any non-2xx is a real failure
    list: async (
      query: paths["/v1/brands"]["get"]["parameters"]["query"] = {},
    ) => {
      const result = await client.GET("/v1/brands", { params: { query } });
      return unwrap(result);
    },

    getById: async (
      id: number,
      query: paths["/v1/brands/{id}"]["get"]["parameters"]["query"] = {},
    ) => {
      const path: paths["/v1/brands/{id}"]["get"]["parameters"]["path"] = {
        id: String(id),
      };
      const result = await client.GET("/v1/brands/{id}", {
        params: { path, query },
      });
      return unwrapOrUndefinedOn(result, 404);
    },
  };
}
