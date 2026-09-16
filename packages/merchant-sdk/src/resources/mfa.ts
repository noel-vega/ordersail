import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

export function createMfaResource(client: Client<paths>, doRequest: DoFn) {
  return {
    // no body — generates a pending secret, returns its otpauth:// URI
    enroll: async () =>
      unwrap(await doRequest(() => client.POST("/auth/mfa/enroll"))),

    confirm: async (params: components["schemas"]["MfaConfirmDto"]) =>
      unwrap(
        await doRequest(() =>
          client.POST("/auth/mfa/confirm", { body: params }),
        ),
      ),

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
