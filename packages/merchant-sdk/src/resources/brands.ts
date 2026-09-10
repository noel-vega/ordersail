import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import type { DoFn } from "../http.js";

export function createBrandsResource(client: Client<paths>, doRequest: DoFn) {
  return {
    list: async (params?: { limit?: number; offset?: number; q?: string }) => {
      const query: NonNullable<
        paths["/brands"]["get"]["parameters"]["query"]
      > = {
        limit: params?.limit ?? 20,
        offset: params?.offset ?? 0,
        ...(params?.q ? { q: params.q } : {}),
      };
      const { data } = await doRequest(() =>
        client.GET("/brands", { params: { query } }),
      );
      return data;
    },

    create: async (params: components["schemas"]["CreateBrandDto"]) => {
      const { data } = await doRequest(() =>
        client.POST("/brands", { body: params }),
      );
      return data;
    },
  };
}
