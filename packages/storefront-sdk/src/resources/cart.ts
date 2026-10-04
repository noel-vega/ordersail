import type { Client } from "openapi-fetch";
import type { components, paths } from "../types.gen.js";
import { unwrap, unwrapOrUndefinedOn } from "../http.js";

const CART_TOKEN_HEADER = "x-cart-token";

export function createCartResource(
  client: Client<paths>,
  getCartToken: () => string | undefined,
  setCartToken: (token: string) => void,
) {
  // x-cart-token isn't a documented OpenAPI header parameter (it's read via
  // a plain decorator server-side, not @ApiHeader), so it's sent as a raw
  // fetch header rather than through the typed params.header slot
  function cartHeaders(): Record<string, string> {
    const token = getCartToken();
    return token ? { [CART_TOKEN_HEADER]: token } : {};
  }

  // addItem may create a cart server-side and hand back a new token — this
  // captures it so the caller doesn't have to wire that up by hand. addItem
  // always calls this with unwrap()'s result, which is defined or throws —
  // never undefined — so this stays non-optional rather than re-widening it.
  function captureToken(cart: components["schemas"]["Cart"]) {
    setCartToken(cart.token);
    return cart;
  }

  return {
    addItem: async (body: components["schemas"]["AddCartItemDto"]) => {
      const result = await client.POST("/v1/cart/items", {
        body,
        headers: cartHeaders(),
      });
      return captureToken(unwrap(result));
    },

    // 404 = no cart yet for this token — the everyday first-visit case
    get: async () => {
      const result = await client.GET("/v1/cart", { headers: cartHeaders() });
      return unwrapOrUndefinedOn(result, 404);
    },

    updateItem: async (
      variantId: number,
      body: components["schemas"]["UpdateCartItemDto"],
    ) => {
      const path: paths["/v1/cart/items/{variantId}"]["patch"]["parameters"]["path"] =
        { variantId: String(variantId) };
      const result = await client.PATCH("/v1/cart/items/{variantId}", {
        params: { path },
        body,
        headers: cartHeaders(),
      });
      return unwrap(result);
    },

    removeItem: async (variantId: number) => {
      const path: paths["/v1/cart/items/{variantId}"]["delete"]["parameters"]["path"] =
        { variantId: String(variantId) };
      const result = await client.DELETE("/v1/cart/items/{variantId}", {
        params: { path },
        headers: cartHeaders(),
      });
      return unwrap(result);
    },

    clear: async () => {
      const result = await client.DELETE("/v1/cart", { headers: cartHeaders() });
      return unwrap(result);
    },
  };
}
