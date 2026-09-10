import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import type { DoFn } from "../http.js";

export function createOnboardingResource(client: Client<paths>, doRequest: DoFn) {
  return {
    getStatus: async () => {
      const { data } = await doRequest(() =>
        client.GET("/onboarding/status"),
      );
      return data;
    },
  };
}
