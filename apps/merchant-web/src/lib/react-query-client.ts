import { MutationCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "merchant-sdk";
import { toast } from "ui/sonner";

// Every mutation failure surfaces as a toast by default (the SDK's mutating
// methods throw `ApiError` with the server's message). A mutation that shows
// its own inline error — sheets, dialogs — opts out with
// `meta: { skipGlobalErrorToast: true }`.
declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      skipGlobalErrorToast?: boolean;
    };
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // a 403 in a query means the section's permission was lost — let it throw
      // to the nearest error boundary (→ RouteError → <AccessDenied/>) instead
      // of the view silently rendering an empty list
      throwOnError: (error) => error instanceof ApiError && error.status === 403,
    },
  },
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.meta?.skipGlobalErrorToast) return;

      // Backstop for the factor gate (OS-492). The three gated actions check
      // hasMfaFactor before firing, so this should never be reached — but a
      // stale claim or a future gated route would otherwise show a bare
      // message with nothing to do about it. The action makes it recoverable.
      //
      // A toast rather than a modal, deliberately: opening a dialog from a
      // module-level cache needs a provider and an imperative handle wired
      // through the app shell, which is a lot of machinery for a path that
      // shouldn't fire.
      if (error instanceof ApiError && error.code === "MFA_FACTOR_REQUIRED") {
        toast.error(error.message, {
          action: {
            label: "Set one up",
            onClick: () => {
              window.location.href = "/app/settings/security";
            },
          },
        });
        return;
      }

      toast.error(
        error instanceof ApiError
          ? error.message
          : "Something went wrong. Please try again.",
      );
    },
  }),
});
