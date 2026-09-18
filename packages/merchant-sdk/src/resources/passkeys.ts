import type { Client } from "openapi-fetch";
import type { paths, components } from "../types.gen.js";
import { unwrap, type DoFn } from "../http.js";

// Deliberately no @simplewebauthn/browser dependency here. This package has
// exactly one dependency (openapi-fetch) and has to stay usable in Node; the
// ceremony library touches navigator.credentials and would break that. These
// methods move the raw JSON in both directions, and merchant-web wraps
// startRegistration()/startAuthentication() around them.
//
// The options and response payloads are typed as plain objects because
// @nestjs/swagger can't model PublicKeyCredentialCreationOptionsJSON, so
// openapi-typescript renders it as an open object. merchant-web casts once,
// at the ceremony call.
export function createPasskeysResource(
  client: Client<paths>,
  doRequest: DoFn,
  setAccessToken: (token: string) => void,
) {
  return {
    list: async () =>
      unwrap(await doRequest(() => client.GET("/auth/passkeys"))),

    registerOptions: async () =>
      unwrap(
        await doRequest(() => client.POST("/auth/passkeys/register/options")),
      ),

    // The response carries a fresh access token for the same reason
    // mfa.confirm does: the caller's current one still says hasMfaFactor
    // false, and a gated action would keep 403ing on that stale claim for
    // the rest of its 8h life. It also carries recoveryCodes, but only when
    // this was the user's first factor of any kind — shown once, never again.
    registerVerify: async (
      params: components["schemas"]["PasskeyRegisterVerifyDto"],
    ) => {
      const result = unwrap(
        await doRequest(() =>
          client.POST("/auth/passkeys/register/verify", { body: params }),
        ),
      );
      if (result.access_token) setAccessToken(result.access_token);
      return result;
    },

    rename: async (
      id: number,
      params: components["schemas"]["PasskeyRenameDto"],
    ) =>
      unwrap(
        await doRequest(() =>
          client.PATCH("/auth/passkeys/{id}", {
            params: { path: { id } },
            body: params,
          }),
        ),
      ),

    remove: async (
      id: number,
      params: components["schemas"]["PasskeyRemoveDto"],
    ) =>
      unwrap(
        await doRequest(() =>
          client.POST("/auth/passkeys/{id}/remove", {
            params: { path: { id } },
            body: params,
          }),
        ),
      ),
  };
}
