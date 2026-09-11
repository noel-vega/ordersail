import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createCategoriesResource(client: Client<paths>, doRequest: DoFn) {
  return {
    list: async (params?: { limit?: number; offset?: number; q?: string }) => {
      const query: NonNullable<
        paths["/categories"]["get"]["parameters"]["query"]
      > = {
        limit: params?.limit ?? 20,
        offset: params?.offset ?? 0,
        ...(params?.q ? { q: params.q } : {}),
      };
      const { data } = await doRequest(() =>
        client.GET("/categories", { params: { query } }),
      );
      return data;
    },

    create: async (params: components["schemas"]["CreateCategoryDto"]) =>
      unwrap(
        await doRequest(() => client.POST("/categories", { body: params })),
      ),

    update: async (
      id: number,
      params: components["schemas"]["UpdateCategoryDto"],
    ) => {
      const path: paths["/categories/{id}"]["patch"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() =>
          client.PATCH("/categories/{id}", { params: { path }, body: params }),
        ),
      );
    },

    remove: async (id: number) => {
      const path: paths["/categories/{id}"]["delete"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() =>
          client.DELETE("/categories/{id}", { params: { path } }),
        ),
      );
    },
  };
}
