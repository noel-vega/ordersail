import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import type { DoFn } from "../http.js";

type MovementReason =
  components["schemas"]["InventoryMovementRecord"]["reason"];

export function createInventoryResource(
  client: Client<paths>,
  doRequest: DoFn,
) {
  return {
    list: async (params?: {
      limit?: number;
      offset?: number;
      q?: string;
      productId?: number;
      locationId?: number;
      stockLte?: number;
    }) => {
      const query: NonNullable<
        paths["/inventory"]["get"]["parameters"]["query"]
      > = {
        limit: params?.limit ?? 20,
        offset: params?.offset ?? 0,
        ...(params?.q ? { q: params.q } : {}),
        ...(params?.productId != null ? { productId: params.productId } : {}),
        ...(params?.locationId != null
          ? { locationId: params.locationId }
          : {}),
        ...(params?.stockLte != null ? { stockLte: params.stockLte } : {}),
      };
      const { data } = await doRequest(() =>
        client.GET("/inventory", { params: { query } }),
      );
      return data;
    },

    movements: {
      list: async (params?: {
        limit?: number;
        offset?: number;
        variantId?: number;
        locationId?: number;
        reason?: MovementReason;
      }) => {
        const query: NonNullable<
          paths["/inventory/movements"]["get"]["parameters"]["query"]
        > = {
          limit: params?.limit ?? 20,
          offset: params?.offset ?? 0,
          ...(params?.variantId != null ? { variantId: params.variantId } : {}),
          ...(params?.locationId != null
            ? { locationId: params.locationId }
            : {}),
          ...(params?.reason ? { reason: params.reason } : {}),
        };
        const { data } = await doRequest(() =>
          client.GET("/inventory/movements", { params: { query } }),
        );
        return data;
      },

      create: async (
        params: components["schemas"]["CreateInventoryMovementDto"],
      ) => {
        const { data } = await doRequest(() =>
          client.POST("/inventory/movements", { body: params }),
        );
        return data;
      },
    },
  };
}
