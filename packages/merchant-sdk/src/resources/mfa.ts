import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createMfaResource(
  client: Client<paths>,
  doRequest: DoFn,
  setAccessToken: (token: string) => void,
) {
  return {
    // no body — generates a pending secret, returns its otpauth:// URI
    enroll: async () =>
      unwrap(await doRequest(() => client.POST("/auth/mfa/enroll"))),

    // the response carries a fresh access token (OS-473) — a caller who
    // was gated into forced enrollment needs it applied immediately, or
    // every subsequent request keeps 403ing on the stale pre-confirm claim
    confirm: async (params: components["schemas"]["MfaConfirmDto"]) => {
      const result = unwrap(
        await doRequest(() =>
          client.POST("/auth/mfa/confirm", { body: params }),
        ),
      );
      if (result.access_token) setAccessToken(result.access_token);
      return result;
    },

    // Removing a factor is a credential change (OS-554): the API revokes
    // every other session and rotates this browser's refresh cookie in place,
    // exactly as changePassword() does, so the caller stays signed in here.
    // The re-minted access token it hands back is adopted for the same
    // reason — its claims were recomputed from the database.
    disable: async (params: components["schemas"]["MfaDisableDto"]) => {
      const result = unwrap(
        await doRequest(() =>
          client.POST("/auth/mfa/disable", { body: params }),
        ),
      );
      if (result.access_token) setAccessToken(result.access_token);
      return result;
    },

    regenerateRecoveryCodes: async (
      params: components["schemas"]["MfaRegenerateRecoveryCodesDto"],
    ) =>
      unwrap(
        await doRequest(() =>
          client.POST("/auth/mfa/recovery-codes/regenerate", {
            body: params,
          }),
        ),
      ),
  };
}
