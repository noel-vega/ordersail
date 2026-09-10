import { queryOptions, useMutation, useQuery } from "@tanstack/react-query"
import { merchantApi } from "../../lib/merchant-api-client"
import { queryClient } from "../../lib/react-query-client";
import type { GetImageUploadUrlDto } from "merchant-sdk";

export function getListProductsQueryOptions() {
    return queryOptions({
        queryKey: ['products'],
        queryFn: () => merchantApi.products.list()
    })
}

export function useListProductsQuery() {
    return useQuery(getListProductsQueryOptions())
}


export function useCreateProductMutation() {
  return useMutation({
    mutationFn: merchantApi.products.create,
    onSuccess: () => {
      queryClient.invalidateQueries(getListProductsQueryOptions());
    },
  });
}

export function getProductQueryOptions(id: number) {
  return queryOptions({
    queryKey: ['products', id],
    queryFn: () => merchantApi.products.getById(id)
  })
}

export function useProductQuery(id: number) {
  return useQuery(getProductQueryOptions(id))
}

export function getProductVariantsQueryOptions(id: number) {
  return queryOptions({
    queryKey: ['products', id, 'variants'],
    queryFn: () => merchantApi.products.variants.list(id)
  })
}

export function useProductVariantsQuery(id: number) {
  return useQuery(getProductVariantsQueryOptions(id))
}

export function useCreateVariantsMutation(productId: number) {
  return useMutation({
    mutationFn: (params: Parameters<typeof merchantApi.products.variants.create>[1]) =>
      merchantApi.products.variants.create(productId, params),
    onSuccess: () => {
      queryClient.invalidateQueries(getProductQueryOptions(productId));
      queryClient.invalidateQueries(getProductVariantsQueryOptions(productId));
      queryClient.invalidateQueries(getProductOptionsQueryOptions(productId));
    },
  });
}

export function getProductOptionsQueryOptions(id: number) {
  return queryOptions({
    queryKey: ['products', id, 'options'],
    queryFn: () => merchantApi.products.options.list(id)
  })
}

export function useProductOptionsQuery(id: number) {
  return useQuery(getProductOptionsQueryOptions(id))
}

export function useDeleteProductOptionMutation(productId: number) {
  return useMutation({
    mutationFn: (optionId: number) =>
      merchantApi.products.options.remove(productId, optionId),
    onSuccess: () => {
      queryClient.invalidateQueries(getProductOptionsQueryOptions(productId));
      queryClient.invalidateQueries(getProductVariantsQueryOptions(productId));
      queryClient.invalidateQueries(getProductQueryOptions(productId));
    },
  });
}

export function useUpdateProductOptionMutation(productId: number) {
  return useMutation({
    mutationFn: ({ optionId, name }: { optionId: number; name: string }) =>
      merchantApi.products.options.update(productId, optionId, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries(getProductOptionsQueryOptions(productId));
    },
  });
}

export function useDeleteProductOptionValueMutation(productId: number) {
  return useMutation({
    mutationFn: ({
      optionId,
      valueId,
    }: {
      optionId: number;
      valueId: number;
    }) => merchantApi.products.options.values.remove(productId, optionId, valueId),
    onSuccess: () => {
      queryClient.invalidateQueries(getProductOptionsQueryOptions(productId));
      queryClient.invalidateQueries(getProductVariantsQueryOptions(productId));
    },
  });
}

export function useDeleteProductMutation() {
  return useMutation({
    mutationFn: merchantApi.products.remove,
    onSuccess: () => {
      queryClient.invalidateQueries(getListProductsQueryOptions());
    },
  });
}

export function useUpdateProductMutation(id: number) {
  return useMutation({
    mutationFn: (params: Parameters<typeof merchantApi.products.update>[1]) =>
      merchantApi.products.update(id, params),
    onSuccess: () => {
      queryClient.invalidateQueries(getProductQueryOptions(id));
      queryClient.invalidateQueries(getListProductsQueryOptions());
    },
  });
}

export function useUpdateVariantMutation(productId: number) {
  return useMutation({
    mutationFn: ({
      variantId,
      ...params
    }: { variantId: number } & Parameters<
      typeof merchantApi.products.variants.update
    >[2]) => merchantApi.products.variants.update(productId, variantId, params),
    onSuccess: () => {
      queryClient.invalidateQueries(getProductVariantsQueryOptions(productId));
    },
  });
}

// three-step upload: get a presigned URL, PUT the file directly to storage
// (never through this API), then confirm the record with the returned key
export function useUploadProductImageMutation(productId: number) {
  return useMutation({
    mutationFn: async ({ file, variantId }: { file: File; variantId?: number }) => {
      const uploadInfo = await merchantApi.products.images.getUploadUrl(productId, {
        contentType: file.type as GetImageUploadUrlDto["contentType"],
      });
      if (!uploadInfo) throw new Error("Could not get an upload URL");

      await fetch(uploadInfo.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });

      return merchantApi.products.images.create(productId, {
        key: uploadInfo.key,
        variantId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(getProductQueryOptions(productId));
      queryClient.invalidateQueries(getProductVariantsQueryOptions(productId));
    },
  });
}

export function useReorderProductImagesMutation(productId: number) {
  return useMutation({
    mutationFn: (imageIds: number[]) =>
      merchantApi.products.images.reorder(productId, { imageIds }),
    onSuccess: () => {
      queryClient.invalidateQueries(getProductQueryOptions(productId));
      queryClient.invalidateQueries(getProductVariantsQueryOptions(productId));
    },
  });
}

export function useDeleteProductImageMutation(productId: number) {
  return useMutation({
    mutationFn: (imageId: number) => merchantApi.products.images.remove(productId, imageId),
    onSuccess: () => {
      queryClient.invalidateQueries(getProductQueryOptions(productId));
      queryClient.invalidateQueries(getProductVariantsQueryOptions(productId));
    },
  });
}