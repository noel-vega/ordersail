import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createRolesResource(client: Client<paths>, doRequest: DoFn) {
  return {
    list: async () => {
      const { data } = await doRequest(() => client.GET("/roles"));
      return data;
    },

    getById: async (id: number) => {
      const path: paths["/roles/{id}"]["get"]["parameters"]["path"] = {
        id: String(id),
      };
      const { data } = await doRequest(() =>
        client.GET("/roles/{id}", { params: { path } }),
      );
      return data;
    },

    create: async (params: components["schemas"]["CreateRoleDto"]) =>
      unwrap(await doRequest(() => client.POST("/roles", { body: params }))),

    update: async (
      id: number,
      params: components["schemas"]["UpdateRoleDto"],
    ) => {
      const path: paths["/roles/{id}"]["patch"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() =>
          client.PATCH("/roles/{id}", { params: { path }, body: params }),
        ),
      );
    },

    remove: async (id: number) => {
      const path: paths["/roles/{id}"]["delete"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() =>
          client.DELETE("/roles/{id}", { params: { path } }),
        ),
      );
    },
  };
}
