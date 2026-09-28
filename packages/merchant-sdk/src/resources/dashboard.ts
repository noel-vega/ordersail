import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export type DashboardRangeParams = NonNullable<
  paths["/dashboard/sales"]["get"]["parameters"]["query"]
>;

// only the params that are set — an empty `from=` would 400
function rangeQuery(params?: DashboardRangeParams): DashboardRangeParams {
  return {
    ...(params?.from ? { from: params.from } : {}),
    ...(params?.to ? { to: params.to } : {}),
    ...(params?.range ? { range: params.range } : {}),
  };
}

export function createDashboardResource(
  client: Client<paths>,
  doRequest: DoFn,
) {
  return {
    get: async () => unwrap(await doRequest(() => client.GET("/dashboard"))),

    // net sales / orders / AOV for a range of local dates in the account's
    // timezone (both inclusive), plus the equal-length previous period.
    // `range` is a preset ending today in the account's zone (the server
    // resolves it); omitted -> the last 30 days (OS-669, OS-193)
    sales: async (params?: DashboardRangeParams) => {
      const query = rangeQuery(params);
      // unwrapped: a 400 must surface as an ApiError, not resolve to
      // undefined (which fails the query without the server's message)
      return unwrap(
        await doRequest(() =>
          client.GET("/dashboard/sales", { params: { query } }),
        ),
      );
    },

    // variants at or below the account's low-stock threshold, summed across
    // locations, lowest stock first; `limit` 1–50, default 10 (OS-195)
    lowStock: async (params?: { limit?: number }) =>
      unwrap(
        await doRequest(() =>
          client.GET("/dashboard/low-stock", {
            params: {
              query: params?.limit !== undefined ? { limit: params.limit } : {},
            },
          }),
        ),
      ),

    // the same money in zero-filled day/week/month buckets (the server picks
    // the granularity from the span) for the trend charts (OS-670)
    salesTimeseries: async (params?: DashboardRangeParams) =>
      unwrap(
        await doRequest(() =>
          client.GET("/dashboard/sales/timeseries", {
            params: { query: rangeQuery(params) },
          }),
        ),
      ),
  };
}
