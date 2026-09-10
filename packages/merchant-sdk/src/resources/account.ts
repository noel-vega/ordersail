import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createAccountResource(client: Client<paths>, doRequest: DoFn) {
  return {
    get: async () => {
      const { data } = await doRequest(() => client.GET("/account"));
      return data;
    },

    update: async (params: components["schemas"]["UpdateAccountDto"]) =>
      unwrap(await doRequest(() => client.PATCH("/account", { body: params }))),
  };
}
