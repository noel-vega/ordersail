import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createLocationsResource(client: Client<paths>, doRequest: DoFn) {
  return {
    list: async (params?: { limit?: number; offset?: number; q?: string }) => {
      const query: NonNullable<
        paths["/locations"]["get"]["parameters"]["query"]
      > = {
        limit: params?.limit ?? 20,
        offset: params?.offset ?? 0,
        ...(params?.q ? { q: params.q } : {}),
      };
      const { data } = await doRequest(() =>
        client.GET("/locations", { params: { query } }),
      );
      return data;
    },

    create: async (params: components["schemas"]["CreateLocationDto"]) =>
      unwrap(
        await doRequest(() => client.POST("/locations", { body: params })),
      ),

    update: async (
      id: number,
      params: components["schemas"]["UpdateLocationDto"],
    ) => {
      const path: paths["/locations/{id}"]["patch"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() =>
          client.PATCH("/locations/{id}", { params: { path }, body: params }),
        ),
      );
    },

    remove: async (id: number) => {
      const path: paths["/locations/{id}"]["delete"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() =>
          client.DELETE("/locations/{id}", { params: { path } }),
        ),
      );
    },
  };
}
