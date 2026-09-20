import type { Client } from "openapi-fetch";
import type { paths } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createStripeConnectResource(client: Client<paths>, doRequest: DoFn) {
  return {
    getStatus: async (params?: { refresh?: boolean }) => {
      const query: paths["/stripe-connect/status"]["get"]["parameters"]["query"] =
        params?.refresh !== undefined ? { refresh: params.refresh } : {};
      const { data } = await doRequest(() =>
        client.GET("/stripe-connect/status", { params: { query } }),
      );
      return data;
    },

    // Starts (or resumes) Stripe-hosted onboarding — the money action, and
    // the one behind the factor gate (OS-492). Throws ApiError with code
    // MFA_FACTOR_REQUIRED when the caller holds no passkey or authenticator.
    //
    // The returned url is single-use and expires within minutes: navigate to
    // it immediately, and ask again rather than reusing one.
    createOnboardingLink: async () =>
      unwrap(
        await doRequest(() =>
          client.POST("/stripe-connect/onboarding-link"),
        ),
      ),

    // Ungated: the embedded management and balance components call this on
    // every Payments load for an already-connected merchant.
    createAccountSession: async () =>
      unwrap(
        await doRequest(() =>
          client.POST("/stripe-connect/account-session"),
        ),
      ),
  };
}
