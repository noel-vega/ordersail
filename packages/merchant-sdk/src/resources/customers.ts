import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import type { DoFn } from "../http.js";

export function createCustomersResource(client: Client<paths>, doRequest: DoFn) {
  return {
    list: async (params?: { limit?: number; offset?: number; q?: string }) => {
      const query: NonNullable<
        paths["/customers"]["get"]["parameters"]["query"]
      > = {
        limit: params?.limit ?? 20,
        offset: params?.offset ?? 0,
        ...(params?.q ? { q: params.q } : {}),
      };
      const { data } = await doRequest(() =>
        client.GET("/customers", { params: { query } }),
      );
      return data;
    },
  };
}
