import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createStripeConnectResource(client: Client<paths>, doRequest: DoFn) {
  return {
    getStatus: async (params?: { refresh?: boolean }) => {
      const query: paths["/stripe-connect/status"]["get"]["parameters"]["query"] =
        params?.refresh !== undefined ? { refresh: params.refresh } : {};
      const { data } = await doRequest(() =>
        client.GET("/stripe-connect/status", { params: { query } }),
      );
      return data;
    },

    createAccountSession: async () =>
      unwrap(
        await doRequest(() =>
          client.POST("/stripe-connect/account-session"),
        ),
      ),
  };
}
