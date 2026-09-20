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
      // Backstop for the factor gate (OS-492), checked BEFORE
      // skipGlobalErrorToast. That flag means "this form shows its own
      // message", which is right for a validation error and wrong here: the
      // gated mutations mostly set it, so honouring it first suppressed the
      // backstop on exactly the paths it exists for. The realistic case is a
      // stale claim — removing the last factor in another tab while this
      // one's /auth/me is still inside its 60s staleTime — where the form
      // would otherwise render a bare string with no way to act on it.
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
              // Dynamic import, not a static one: main.tsx owns the router
              // and renders on import, and it already imports this module —
              // a static import would be a cycle that re-enters the entry
              // point. By the time this callback can run, main has long been
              // evaluated, so this resolves the existing instance.
              //
              // Routing rather than window.location: a hard reload throws
              // away in-flight router and query state, including whatever
              // the user had typed into the form that just failed.
              void import("../main").then(({ router }) =>
                router.navigate({ to: "/app/me/security" }),
              );
            },
          },
        });
        return;
      }

      if (mutation.meta?.skipGlobalErrorToast) return;

      toast.error(
        error instanceof ApiError
          ? error.message
          : "Something went wrong. Please try again.",
      );
    },
  }),
});
