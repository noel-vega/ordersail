import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createOrdersResource(client: Client<paths>, doRequest: DoFn) {
  return {
    list: async (params?: { limit?: number; offset?: number }) => {
      const query: paths["/orders"]["get"]["parameters"]["query"] = {
        limit: params?.limit ?? 20,
        offset: params?.offset ?? 0,
      };
      const { data } = await doRequest(() =>
        client.GET("/orders", { params: { query } }),
      );
      return data;
    },

    getById: async (id: number) => {
      const path: paths["/orders/{id}"]["get"]["parameters"]["path"] = {
        id: String(id),
      };
      const { data } = await doRequest(() =>
        client.GET("/orders/{id}", { params: { path } }),
      );
      return data;
    },

    // mutations use `unwrap` so a non-2xx (e.g. a 409 over-refund) throws an
    // ApiError carrying the server's message, for the caller to show inline
    transitionStatus: async (
      id: number,
      body: components["schemas"]["UpdateOrderStatusDto"],
    ) =>
      unwrap(
        await doRequest(() =>
          client.PATCH("/orders/{id}/status", {
            params: { path: { id } },
            body,
          }),
        ),
      ),

    refund: async (
      id: number,
      body: components["schemas"]["RefundOrderDto"],
    ) =>
      unwrap(
        await doRequest(() =>
          client.POST("/orders/{id}/refunds", {
            params: { path: { id } },
            body,
          }),
        ),
      ),

    cancel: async (
      id: number,
      body: components["schemas"]["CancelOrderDto"],
    ) =>
      unwrap(
        await doRequest(() =>
          client.POST("/orders/{id}/cancel", {
            params: { path: { id } },
            body,
          }),
        ),
      ),
  };
}
