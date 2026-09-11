import type { Client } from "openapi-fetch";
import type { components, paths } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createApiKeysResource(client: Client<paths>, doRequest: DoFn) {
  return {
    list: async () => {
      const { data } = await doRequest(() => client.GET("/api-keys"));
      return data;
    },

    create: async (params?: components["schemas"]["CreateApiKeyDto"]) =>
      unwrap(
        await doRequest(() =>
          client.POST("/api-keys", { body: params ?? {} }),
        ),
      ),

    remove: async (id: number) => {
      const path: paths["/api-keys/{id}"]["delete"]["parameters"]["path"] = {
        id,
      };
      return unwrap(
        await doRequest(() =>
          client.DELETE("/api-keys/{id}", { params: { path } }),
        ),
      );
    },
  };
}
