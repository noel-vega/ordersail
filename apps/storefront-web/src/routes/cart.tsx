import {
  Form,
  Link,
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
} from "react-router";
import { MinusIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { CartItem } from "storefront-sdk";
import { storefrontApi } from "../lib/storefront-api-client";
import { setStoredCartToken } from "../lib/cart-token";
import { Button, Separator } from "../components/ui";

export async function cartLoader() {
  const cart = await storefrontApi.cart.get();
  return cart ?? null;
}

export async function cartAction({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "update-quantity") {
    const variantId = Number(formData.get("variantId"));
    const quantity = Number(formData.get("quantity"));
    await storefrontApi.cart.updateItem(variantId, { quantity });
  } else if (intent === "remove-item") {
    const variantId = Number(formData.get("variantId"));
    await storefrontApi.cart.removeItem(variantId);
  } else if (intent === "clear") {
    await storefrontApi.cart.clear();
  }

  setStoredCartToken(storefrontApi.cartToken);
  return null;
}

function formatPrice(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function CartPage() {
  const cart = useLoaderData<typeof cartLoader>();

  if (!cart || cart.items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center">
        <h1 className="text-2xl font-medium">Your cart is empty</h1>
        <Link
          to="/products"
          className="mt-4 inline-block text-sm text-muted-foreground hover:underline"
        >
          ← Continue shopping
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-medium">Your cart</h1>

      <div className="mt-6 divide-y">
        {cart.items.map((item) => (
          <CartLine key={item.variantId} item={item} />
        ))}
      </div>

      <Separator className="my-4" />

      <div className="flex items-center justify-between">
        <Form method="post">
          <input type="hidden" name="intent" value="clear" />
          <Button type="submit" variant="ghost" size="sm">
            Clear cart
          </Button>
        </Form>
        <div className="text-right">
          <p className="text-sm text-muted-foreground">{cart.itemCount} items</p>
          <p className="text-lg font-medium">
            Subtotal: {formatPrice(cart.subtotalCents)}
          </p>
          <Link to="/checkout" className="mt-2 inline-block">
            <Button>Checkout</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function CartLine({ item }: { item: CartItem }) {
  const fetcher = useFetcher();

  const optionsLabel = item.optionValues
    .map((ov) => `${ov.optionName}: ${ov.value}`)
    .join(", ");

  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div>
        <p className="font-medium">{item.productName}</p>
        {optionsLabel && (
          <p className="text-sm text-muted-foreground">{optionsLabel}</p>
        )}
        <p className="text-sm text-muted-foreground">
          {formatPrice(item.priceCents)}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <fetcher.Form method="post" className="flex items-center gap-1">
          <input type="hidden" name="intent" value="update-quantity" />
          <input type="hidden" name="variantId" value={item.variantId} />
          <input
            type="hidden"
            name="quantity"
            value={Math.max(item.quantity - 1, 1)}
          />
          <Button
            type="submit"
            variant="outline"
            size="icon-sm"
            disabled={item.quantity <= 1}
            aria-label="Decrease quantity"
          >
            <MinusIcon />
          </Button>
        </fetcher.Form>

        <span className="w-6 text-center">{item.quantity}</span>

        <fetcher.Form method="post" className="flex items-center gap-1">
          <input type="hidden" name="intent" value="update-quantity" />
          <input type="hidden" name="variantId" value={item.variantId} />
          <input type="hidden" name="quantity" value={item.quantity + 1} />
          <Button
            type="submit"
            variant="outline"
            size="icon-sm"
            aria-label="Increase quantity"
          >
            <PlusIcon />
          </Button>
        </fetcher.Form>

        <p className="w-20 text-right font-medium">
          {formatPrice(item.priceCents * item.quantity)}
        </p>

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="remove-item" />
          <input type="hidden" name="variantId" value={item.variantId} />
          <Button type="submit" variant="ghost" size="icon-sm" aria-label="Remove">
            <Trash2Icon />
          </Button>
        </fetcher.Form>
      </div>
    </div>
  );
}
