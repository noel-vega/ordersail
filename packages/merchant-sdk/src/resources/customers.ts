import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

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

    get: async (id: number) =>
      unwrap(
        await doRequest(() =>
          client.GET("/customers/{id}", { params: { path: { id } } }),
        ),
      ),

    getOrders: async (
      id: number,
      params?: { limit?: number; offset?: number },
    ) => {
      const query: NonNullable<
        paths["/customers/{id}/orders"]["get"]["parameters"]["query"]
      > = {
        limit: params?.limit ?? 20,
        offset: params?.offset ?? 0,
      };
      const { data } = await doRequest(() =>
        client.GET("/customers/{id}/orders", {
          params: { path: { id }, query },
        }),
      );
      return data;
    },
  };
}
