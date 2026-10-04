import type { Client } from "openapi-fetch";
import type { components, paths } from "../types.gen.js";
import { unwrap, unwrapOrUndefinedOn } from "../http.js";

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
    // no legitimate "empty" case — always returns a body (ready: boolean)
    getConfig: async () => {
      const result = await client.GET("/v1/checkout/config");
      return unwrap(result);
    },

    createSession: async (body: components["schemas"]["CreateCheckoutSessionDto"]) => {
      const result = await client.POST("/v1/checkout/session", {
        body,
        headers: cartHeaders(),
      });
      return unwrap(result);
    },

    // 404 = no connected Stripe account, or an unknown/expired session id
    getSessionStatus: async (sessionId: string) => {
      const path: paths["/v1/checkout/session/{sessionId}"]["get"]["parameters"]["path"] =
        { sessionId };
      const result = await client.GET("/v1/checkout/session/{sessionId}", {
        params: { path },
      });
      return unwrapOrUndefinedOn(result, 404);
    },

    // no legitimate "empty" case — a computed result, not a lookup
    getShippingOptions: async (
      body: components["schemas"]["GetShippingOptionsDto"],
    ) => {
      const result = await client.POST("/v1/checkout/shipping-options", { body });
      return unwrap(result);
    },
  };
}
