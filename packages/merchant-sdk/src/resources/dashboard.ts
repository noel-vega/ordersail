import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import type { DoFn } from "../http.js";

export function createDashboardResource(client: Client<paths>, doRequest: DoFn) {
  return {
    get: async () => {
      const { data } = await doRequest(() => client.GET("/dashboard"));
      return data;
    },

    // net sales / orders / AOV for a range of local dates in the account's
    // timezone (both inclusive), plus the equal-length previous period.
    // Omitted -> the last 30 days ending today (OS-669)
    sales: async (params?: { from?: string; to?: string }) => {
      const query: NonNullable<
        paths["/dashboard/sales"]["get"]["parameters"]["query"]
      > = {
        ...(params?.from ? { from: params.from } : {}),
        ...(params?.to ? { to: params.to } : {}),
      };
      const { data } = await doRequest(() =>
        client.GET("/dashboard/sales", { params: { query } }),
      );
      return data;
    },
  };
}
