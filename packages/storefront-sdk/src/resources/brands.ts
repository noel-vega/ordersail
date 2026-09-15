import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import { unwrap, unwrapOrUndefinedOn } from "../http.js";

export function createBrandsResource(client: Client<paths>) {
  return {
    // no legitimate "empty" case for a list — any non-2xx is a real failure
    list: async (
      query: paths["/brands"]["get"]["parameters"]["query"] = {},
    ) => {
      const result = await client.GET("/brands", { params: { query } });
      return unwrap(result);
    },

    getById: async (
      id: number,
      query: paths["/brands/{id}"]["get"]["parameters"]["query"] = {},
    ) => {
      const path: paths["/brands/{id}"]["get"]["parameters"]["path"] = {
        id: String(id),
      };
      const result = await client.GET("/brands/{id}", {
        params: { path, query },
      });
      return unwrapOrUndefinedOn(result, 404);
    },
  };
}
