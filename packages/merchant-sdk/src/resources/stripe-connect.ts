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

    // First connect — the money action, and the one behind the factor gate
    // (OS-492). Throws ApiError with code MFA_FACTOR_REQUIRED when the
    // caller holds no passkey or authenticator.
    createOnboardingSession: async () =>
      unwrap(
        await doRequest(() =>
          client.POST("/stripe-connect/onboarding-session"),
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
