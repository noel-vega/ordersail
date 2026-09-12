import { Link, useLoaderData } from "react-router";
import { storefrontApi } from "../lib/storefront-api-client";
import { Card, CardContent, CardHeader, CardTitle, Badge } from "../components/ui";

export async function productsLoader() {
  const products = await storefrontApi.products.list();
  if (!products) {
    throw new Response("Failed to load products", { status: 502 });
  }
  return products;
}

function formatPriceRange(minCents: number | null, maxCents: number | null) {
  if (minCents === null || maxCents === null) return null;
  const format = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  return minCents === maxCents
    ? format(minCents)
    : `${format(minCents)} – ${format(maxCents)}`;
}

export function ProductsPage() {
  const products = useLoaderData<typeof productsLoader>();

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-2xl font-medium">Products</h1>

      {products.items.length === 0 ? (
        <p className="mt-6 text-muted-foreground">No products yet.</p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.items.map((product) => (
            <Link key={product.id} to={`/products/${product.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                {product.thumbnailUrl && (
                  <img
                    src={product.thumbnailUrl}
                    alt={product.name}
                    className="aspect-square w-full object-cover"
                  />
                )}
                <CardHeader>
                  <CardTitle>{product.name}</CardTitle>
                  {product.brand && (
                    <p className="text-sm text-muted-foreground">
                      {product.brand.name}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {formatPriceRange(
                      product.minPriceCents,
                      product.maxPriceCents,
                    ) ?? "—"}
                  </span>
                  {product.categories.map((category) => (
                    <Badge key={category.id} variant="secondary">
                      {category.name}
                    </Badge>
                  ))}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
