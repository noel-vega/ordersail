import { useState } from "react";
import {
  Link,
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { storefrontApi } from "../lib/storefront-api-client";
import { setStoredCartToken } from "../lib/cart-token";
import {
  Badge,
  Button,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui";

export async function productLoader({ params }: LoaderFunctionArgs) {
  const product = await storefrontApi.products.getById(Number(params.id));
  if (!product) {
    throw new Response("Not Found", { status: 404 });
  }
  return product;
}

export async function productAction({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const variantId = Number(formData.get("variantId"));

  await storefrontApi.cart.addItem({ variantId, quantity: 1 });
  setStoredCartToken(storefrontApi.cartToken);

  return null;
}

function formatPrice(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function ProductPage() {
  const product = useLoaderData<typeof productLoader>();

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <Link to="/products" className="text-sm text-muted-foreground hover:underline">
        ← Back to products
      </Link>

      {product.images.length > 0 && <ProductGallery images={product.images} />}

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">{product.name}</h1>
          {product.brand && (
            <p className="text-muted-foreground">{product.brand.name}</p>
          )}
        </div>
        <div className="flex gap-2">
          {product.categories.map((category) => (
            <Badge key={category.id} variant="secondary">
              {category.name}
            </Badge>
          ))}
        </div>
      </div>

      {product.description && (
        <p className="mt-4 text-sm text-muted-foreground">
          {product.description}
        </p>
      )}

      <Separator className="my-6" />

      <h2 className="text-lg font-medium">Variants</h2>
      <Table className="mt-3">
        <TableHeader>
          <TableRow>
            <TableHead></TableHead>
            <TableHead>Options</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Stock</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {product.variants.map((variant) => (
            <TableRow key={variant.id}>
              <TableCell>
                {variant.images.length > 0 && (
                  <img
                    src={variant.images[0].url}
                    alt=""
                    className="size-10 rounded-md object-cover"
                  />
                )}
              </TableCell>
              <TableCell>
                {variant.optionValues.length > 0
                  ? variant.optionValues
                      .map((ov) => `${ov.optionName}: ${ov.value}`)
                      .join(", ")
                  : "—"}
              </TableCell>
              <TableCell>{variant.sku ?? "—"}</TableCell>
              <TableCell>{formatPrice(variant.priceCents)}</TableCell>
              <TableCell>
                {variant.stock > 0 ? variant.stock : (
                  <span className="text-muted-foreground">Out of stock</span>
                )}
              </TableCell>
              <TableCell>
                <AddToCartButton
                  variantId={variant.id}
                  disabled={variant.stock <= 0}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ProductGallery({ images }: { images: { id: number; url: string }[] }) {
  const [activeUrl, setActiveUrl] = useState(images[0].url);

  return (
    <div className="mt-4">
      <img
        src={activeUrl}
        alt=""
        className="aspect-square w-full rounded-lg object-cover"
      />
      {images.length > 1 && (
        <div className="mt-2 flex gap-2">
          {images.map((image) => (
            <button
              key={image.id}
              type="button"
              onClick={() => setActiveUrl(image.url)}
            >
              <img
                src={image.url}
                alt=""
                className="size-16 rounded-md object-cover"
                style={{ opacity: image.url === activeUrl ? 1 : 0.6 }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AddToCartButton({
  variantId,
  disabled,
}: {
  variantId: number;
  disabled: boolean;
}) {
  const fetcher = useFetcher();
  const isAdding = fetcher.state !== "idle";

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="variantId" value={variantId} />
      <Button type="submit" size="sm" disabled={disabled || isAdding}>
        {disabled ? "Out of stock" : isAdding ? "Adding…" : "Add to cart"}
      </Button>
    </fetcher.Form>
  );
}
