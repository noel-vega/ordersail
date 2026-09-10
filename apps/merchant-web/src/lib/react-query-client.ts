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
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Something went wrong. Please try again.",
      );
    },
  }),
});
