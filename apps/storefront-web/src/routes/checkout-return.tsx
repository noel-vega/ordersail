import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { storefrontApi } from "../lib/storefront-api-client";
import { setStoredCartToken } from "../lib/cart-token";
import { Button } from "../components/ui";

// - complete    : paid — the order is on its way (webhook creates it)
// - unconfirmed : checkout finished but the payment hasn't settled (a delayed
//                 method still pending, or one that failed) — cart kept
// - unfinished  : the session expired or was abandoned before paying
// - error       : no session id, or the status lookup itself failed
type Status = "loading" | "unfinished" | "unconfirmed" | "complete" | "error";

export function CheckoutReturnPage() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const [status, setStatus] = useState<Status>("loading");
  const [customerEmail, setCustomerEmail] = useState<string | null>(null);

  // embedded checkout has no server-confirmed redirect like the hosted
  // flow did — the order itself is still created by the webhook, this just
  // checks payment status to decide what to show the customer
  useEffect(() => {
    if (!sessionId) {
      setStatus("error");
      return;
    }
    storefrontApi.checkout
      .getSessionStatus(sessionId)
      .then((result) => {
        if (!result) {
          setStatus("error");
          return;
        }
        setCustomerEmail(result.customerEmail);
        if (result.status === "complete" && result.paymentStatus === "paid") {
          // only a confirmed-paid checkout empties the cart — an unsettled
          // async payment might still fail, so the customer keeps it to retry
          storefrontApi.cartToken = undefined;
          setStoredCartToken(undefined);
          setStatus("complete");
        } else if (result.status === "complete") {
          setStatus("unconfirmed");
        } else {
          setStatus("unfinished");
        }
      })
      .catch(() => setStatus("error"));
  }, [sessionId]);

  if (status === "loading") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center text-sm text-muted-foreground">
        Checking your order…
      </div>
    );
  }

  if (status === "unfinished") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center">
        <h1 className="text-2xl font-medium">Checkout wasn't completed</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your payment wasn't finished — you can try again.
        </p>
        <Link to="/checkout">
          <Button className="mt-6">Return to checkout</Button>
        </Link>
      </div>
    );
  }

  if (status === "unconfirmed") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center">
        <h1 className="text-2xl font-medium">
          We couldn't confirm your payment
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {customerEmail
            ? `We'll email ${customerEmail} as soon as it clears. If it doesn't go through, your cart is still saved so you can try another method.`
            : "We'll confirm by email as soon as it clears. If it doesn't go through, your cart is still saved so you can try another method."}
        </p>
        <Link to="/checkout">
          <Button variant="outline" className="mt-6">
            Back to checkout
          </Button>
        </Link>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center">
        <h1 className="text-2xl font-medium">Something went wrong</h1>
        <Link
          to="/cart"
          className="mt-4 inline-block text-sm text-muted-foreground hover:underline"
        >
          ← Back to cart
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12 text-center">
      <h1 className="text-2xl font-medium">Thanks for your order!</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {customerEmail
          ? `We've sent a confirmation to ${customerEmail}.`
          : "We've received your payment and are getting your order ready."}
      </p>
      <Link to="/products">
        <Button className="mt-6">Continue shopping</Button>
      </Link>
    </div>
  );
}
