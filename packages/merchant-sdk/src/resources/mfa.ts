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

    disable: async (params: components["schemas"]["MfaDisableDto"]) =>
      unwrap(
        await doRequest(() =>
          client.POST("/auth/mfa/disable", { body: params }),
        ),
      ),

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
