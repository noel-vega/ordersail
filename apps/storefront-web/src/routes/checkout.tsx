import { useCallback, useMemo } from "react";
import { loadStripe } from "@stripe/stripe-js";
import type { StripeEmbeddedCheckoutShippingDetailsChangeEvent } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Link, useLoaderData } from "react-router";
import { storefrontApi } from "../lib/storefront-api-client";

export async function checkoutLoader() {
  const [config, cart] = await Promise.all([
    storefrontApi.checkout.getConfig(),
    storefrontApi.cart.get(),
  ]);
  return {
    ready: config?.ready ?? false,
    stripeAccountId: config?.stripeAccountId ?? null,
    cartEmpty: !cart || cart.items.length === 0,
  };
}

export function CheckoutPage() {
  const { ready, stripeAccountId, cartEmpty } = useLoaderData<typeof checkoutLoader>();

  // scopes Stripe.js to this storefront's connected account — same
  // publishable key for every storefront, different stripeAccountId per tenant
  const stripePromise = useMemo(() => {
    if (!ready || !stripeAccountId) return null;
    return loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY, {
      stripeAccount: stripeAccountId,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stripeAccountId]);

  const fetchClientSecret = useCallback(async () => {
    // createSession throws ApiError with the server's real message on
    // failure — no need to check for a falsy session anymore
    const session = await storefrontApi.checkout.createSession({
      returnUrl: `${window.location.origin}/checkout/return`,
    });
    return session.clientSecret;
  }, []);

  // called once the customer finishes entering their shipping address,
  // before they can pay — this is what turns the placeholder "Calculating…"
  // shipping option into real carrier rates
  const onShippingDetailsChange = useCallback(
    async (event: StripeEmbeddedCheckoutShippingDetailsChangeEvent) => {
      const { name, address } = event.shippingDetails;
      const result = await storefrontApi.checkout.getShippingOptions({
        checkoutSessionId: event.checkoutSessionId,
        shippingDetails: {
          name,
          address: {
            country: address.country,
            line1: address.line1 ?? undefined,
            line2: address.line2 ?? undefined,
            city: address.city ?? undefined,
            postal_code: address.postal_code ?? undefined,
            state: address.state ?? undefined,
          },
        },
      });
      if (!result?.ok) {
        return {
          type: "reject" as const,
          errorMessage: result?.errorMessage ?? "We can't calculate shipping to that address",
        };
      }
      return { type: "accept" as const };
    },
    [],
  );

  if (!ready || !stripePromise) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center">
        <h1 className="text-2xl font-medium">Checkout unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This store isn't set up to accept payments yet.
        </p>
        <Link
          to="/cart"
          className="mt-4 inline-block text-sm text-muted-foreground hover:underline"
        >
          ← Back to cart
        </Link>
      </div>
    );
  }

  if (cartEmpty) {
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
      <EmbeddedCheckoutProvider
        stripe={stripePromise}
        options={{ fetchClientSecret, onShippingDetailsChange }}
      >
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
