import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createProductsResource(client: Client<paths>, doRequest: DoFn) {
  return {
    list: async (params?: {
      limit?: number;
      offset?: number;
      q?: string;
      status?: components["schemas"]["Product"]["status"];
    }) => {
      const query: NonNullable<
        paths["/products"]["get"]["parameters"]["query"]
      > = {
        limit: params?.limit ?? 20,
        offset: params?.offset ?? 0,
        ...(params?.q ? { q: params.q } : {}),
        ...(params?.status ? { status: params.status } : {}),
      };
      const { data } = await doRequest(() =>
        client.GET("/products", { params: { query } }),
      );
      return data;
    },

    create: async (params: components["schemas"]["CreateProductDto"]) =>
      unwrap(await doRequest(() => client.POST("/products", { body: params }))),

    getById: async (id: number) => {
      const path: paths["/products/{id}"]["get"]["parameters"]["path"] = {
        id: String(id),
      };
      const { data } = await doRequest(() =>
        client.GET("/products/{id}", { params: { path } }),
      );
      return data;
    },

    update: async (
      id: number,
      params: components["schemas"]["UpdateProductDto"],
    ) => {
      const path: paths["/products/{id}"]["patch"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() =>
          client.PATCH("/products/{id}", { params: { path }, body: params }),
        ),
      );
    },

    remove: async (id: number) => {
      const path: paths["/products/{id}"]["delete"]["parameters"]["path"] = {
        id: String(id),
      };
      return unwrap(
        await doRequest(() =>
          client.DELETE("/products/{id}", { params: { path } }),
        ),
      );
    },

    variants: {
      list: async (productId: number) => {
        const path: paths["/products/{id}/variants"]["get"]["parameters"]["path"] =
          {
            id: String(productId),
          };
        const { data } = await doRequest(() =>
          client.GET("/products/{id}/variants", { params: { path } }),
        );
        return data;
      },

      create: async (
        productId: number,
        params: components["schemas"]["CreateVariantsDto"],
      ) => {
        const path: paths["/products/{id}/variants"]["post"]["parameters"]["path"] =
          {
            id: String(productId),
          };
        return unwrap(
          await doRequest(() =>
            client.POST("/products/{id}/variants", {
              params: { path },
              body: params,
            }),
          ),
        );
      },

      update: async (
        productId: number,
        variantId: number,
        params: components["schemas"]["UpdateVariantDto"],
      ) => {
        const path: paths["/products/{id}/variants/{variantId}"]["patch"]["parameters"]["path"] =
          {
            id: String(productId),
            variantId: String(variantId),
          };
        return unwrap(
          await doRequest(() =>
            client.PATCH("/products/{id}/variants/{variantId}", {
              params: { path },
              body: params,
            }),
          ),
        );
      },
    },

    options: {
      list: async (productId: number) => {
        const path: paths["/products/{id}/options"]["get"]["parameters"]["path"] =
          {
            id: String(productId),
          };
        const { data } = await doRequest(() =>
          client.GET("/products/{id}/options", { params: { path } }),
        );
        return data;
      },

      update: async (
        productId: number,
        optionId: number,
        params: components["schemas"]["UpdateProductOptionDto"],
      ) => {
        const path: paths["/products/{id}/options/{optionId}"]["patch"]["parameters"]["path"] =
          {
            id: String(productId),
            optionId: String(optionId),
          };
        return unwrap(
          await doRequest(() =>
            client.PATCH("/products/{id}/options/{optionId}", {
              params: { path },
              body: params,
            }),
          ),
        );
      },

      remove: async (productId: number, optionId: number) => {
        const path: paths["/products/{id}/options/{optionId}"]["delete"]["parameters"]["path"] =
          {
            id: String(productId),
            optionId: String(optionId),
          };
        return unwrap(
          await doRequest(() =>
            client.DELETE("/products/{id}/options/{optionId}", {
              params: { path },
            }),
          ),
        );
      },

      values: {
        remove: async (productId: number, optionId: number, valueId: number) => {
          const path: paths["/products/{id}/options/{optionId}/values/{valueId}"]["delete"]["parameters"]["path"] =
            {
              id: String(productId),
              optionId: String(optionId),
              valueId: String(valueId),
            };
          return unwrap(
            await doRequest(() =>
              client.DELETE(
                "/products/{id}/options/{optionId}/values/{valueId}",
                { params: { path } },
              ),
            ),
          );
        },
      },
    },

    images: {
      // step 1: get a presigned URL, then PUT the file directly to storage
      // (not through this API) before calling images.create with the key
      getUploadUrl: async (
        productId: number,
        params: components["schemas"]["GetImageUploadUrlDto"],
      ) => {
        const path: paths["/products/{id}/images/upload-url"]["post"]["parameters"]["path"] =
          { id: String(productId) };
        return unwrap(
          await doRequest(() =>
            client.POST("/products/{id}/images/upload-url", {
              params: { path },
              body: params,
            }),
          ),
        );
      },

      create: async (
        productId: number,
        params: components["schemas"]["CreateProductImageDto"],
      ) => {
        const path: paths["/products/{id}/images"]["post"]["parameters"]["path"] =
          { id: String(productId) };
        return unwrap(
          await doRequest(() =>
            client.POST("/products/{id}/images", {
              params: { path },
              body: params,
            }),
          ),
        );
      },

      reorder: async (
        productId: number,
        params: components["schemas"]["ReorderProductImagesDto"],
      ) => {
        const path: paths["/products/{id}/images/order"]["patch"]["parameters"]["path"] =
          { id: String(productId) };
        return unwrap(
          await doRequest(() =>
            client.PATCH("/products/{id}/images/order", {
              params: { path },
              body: params,
            }),
          ),
        );
      },

      remove: async (productId: number, imageId: number) => {
        const path: paths["/products/{id}/images/{imageId}"]["delete"]["parameters"]["path"] =
          { id: String(productId), imageId: String(imageId) };
        return unwrap(
          await doRequest(() =>
            client.DELETE("/products/{id}/images/{imageId}", {
              params: { path },
            }),
          ),
        );
      },
    },
  };
}
