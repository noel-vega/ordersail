import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

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

    create: async (params: components["schemas"]["CreateBrandDto"]) =>
      unwrap(await doRequest(() => client.POST("/brands", { body: params }))),

    update: async (
      id: number,
      params: components["schemas"]["UpdateBrandDto"],
    ) => {
      const path: paths["/brands/{id}"]["patch"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() =>
          client.PATCH("/brands/{id}", { params: { path }, body: params }),
        ),
      );
    },

    remove: async (id: number) => {
      const path: paths["/brands/{id}"]["delete"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() => client.DELETE("/brands/{id}", { params: { path } })),
      );
    },
  };
}
