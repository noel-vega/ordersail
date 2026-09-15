import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import { unwrap, unwrapOrUndefinedOn } from "../http.js";

export function createCategoriesResource(client: Client<paths>) {
  return {
    // no legitimate "empty" case for a list — any non-2xx is a real failure
    list: async (
      query: paths["/categories"]["get"]["parameters"]["query"] = {},
    ) => {
      const result = await client.GET("/categories", { params: { query } });
      return unwrap(result);
    },

    getById: async (
      id: number,
      query: paths["/categories/{id}"]["get"]["parameters"]["query"] = {},
    ) => {
      const path: paths["/categories/{id}"]["get"]["parameters"]["path"] = {
        id: String(id),
      };
      const result = await client.GET("/categories/{id}", {
        params: { path, query },
      });
      return unwrapOrUndefinedOn(result, 404);
    },
  };
}
