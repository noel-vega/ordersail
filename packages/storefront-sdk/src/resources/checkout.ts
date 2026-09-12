import type { Client } from "openapi-fetch";
import type { components, paths } from "../types.gen.js";
import { unwrap } from "../http.js";

const CART_TOKEN_HEADER = "x-cart-token";

export function createCheckoutResource(
  client: Client<paths>,
  getCartToken: () => string | undefined,
) {
  function cartHeaders(): Record<string, string> {
    const token = getCartToken();
    return token ? { [CART_TOKEN_HEADER]: token } : {};
  }

  return {
    getConfig: async () => {
      const { data } = await client.GET("/checkout/config");
      return data;
    },

    createSession: async (body: components["schemas"]["CreateCheckoutSessionDto"]) => {
      const result = await client.POST("/checkout/session", {
        body,
        headers: cartHeaders(),
      });
      return unwrap(result);
    },

    getSessionStatus: async (sessionId: string) => {
      const path: paths["/checkout/session/{sessionId}"]["get"]["parameters"]["path"] =
        { sessionId };
      const { data } = await client.GET("/checkout/session/{sessionId}", {
        params: { path },
      });
      return data;
    },

    getShippingOptions: async (
      body: components["schemas"]["GetShippingOptionsDto"],
    ) => {
      const { data } = await client.POST("/checkout/shipping-options", { body });
      return data;
    },
  };
}
