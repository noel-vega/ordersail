import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createUsersResource(client: Client<paths>, doRequest: DoFn) {
  return {
    list: async (params?: { limit?: number; offset?: number; q?: string }) => {
      const query: NonNullable<
        paths["/users"]["get"]["parameters"]["query"]
      > = {
        limit: params?.limit ?? 20,
        offset: params?.offset ?? 0,
        ...(params?.q ? { q: params.q } : {}),
      };
      const { data } = await doRequest(() =>
        client.GET("/users", { params: { query } }),
      );
      return data;
    },

    create: async (params: components["schemas"]["CreateUserDto"]) =>
      unwrap(await doRequest(() => client.POST("/users", { body: params }))),

    updateRoles: async (id: number, roleIds: number[]) => {
      const path: paths["/users/{id}/roles"]["patch"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() =>
          client.PATCH("/users/{id}/roles", {
            params: { path },
            body: { roleIds },
          }),
        ),
      );
    },
  };
}
