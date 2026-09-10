import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import type { DoFn } from "../http.js";

export function createCategoriesResource(client: Client<paths>, doRequest: DoFn) {
  return {
    list: async (params?: { limit?: number; offset?: number; q?: string }) => {
      const query: NonNullable<
        paths["/categories"]["get"]["parameters"]["query"]
      > = {
        limit: params?.limit ?? 20,
        offset: params?.offset ?? 0,
        ...(params?.q ? { q: params.q } : {}),
      };
      const { data } = await doRequest(() =>
        client.GET("/categories", { params: { query } }),
      );
      return data;
    },

    create: async (params: components["schemas"]["CreateCategoryDto"]) => {
      const { data } = await doRequest(() =>
        client.POST("/categories", { body: params }),
      );
      return data;
    },
  };
}
