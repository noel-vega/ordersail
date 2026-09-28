import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export type DashboardRangeParams = NonNullable<
  paths["/dashboard/sales"]["get"]["parameters"]["query"]
>;

export function createDashboardResource(client: Client<paths>, doRequest: DoFn) {
  return {
    get: async () => {
      const { data } = await doRequest(() => client.GET("/dashboard"));
      return data;
    },

    // net sales / orders / AOV for a range of local dates in the account's
    // timezone (both inclusive), plus the equal-length previous period.
    // `range` is a preset ending today in the account's zone (the server
    // resolves it); omitted -> the last 30 days (OS-669, OS-193)
    sales: async (params?: DashboardRangeParams) => {
      const query: NonNullable<
        paths["/dashboard/sales"]["get"]["parameters"]["query"]
      > = {
        ...(params?.from ? { from: params.from } : {}),
        ...(params?.to ? { to: params.to } : {}),
        ...(params?.range ? { range: params.range } : {}),
      };
      // unwrapped: a 400 must surface as an ApiError, not resolve to
      // undefined (which fails the query without the server's message)
      return unwrap(
        await doRequest(() =>
          client.GET("/dashboard/sales", { params: { query } }),
        ),
      );
    },
  };
}
