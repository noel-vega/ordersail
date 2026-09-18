import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";

export { browserSupportsWebAuthn };

// The ceremony rejects with a raw DOMException whose message is written for
// browser engineers ("The operation either timed out or was not allowed...").
// None of it is showable, and two of the cases aren't errors at all from the
// user's point of view, so every call goes through here.
export class PasskeyCeremonyError extends Error {
  // true when the user simply dismissed the prompt — there's nothing to tell
  // them, and showing an error for "I changed my mind" is noise.
  // Declared as a field rather than a constructor parameter property because
  // this app builds with `erasableSyntaxOnly`.
  readonly silent: boolean;

  constructor(message: string, silent: boolean) {
    super(message);
    this.name = "PasskeyCeremonyError";
    this.silent = silent;
  }
}

function normalize(err: unknown): PasskeyCeremonyError {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "AbortError":
      // the page aborted the request, or the user closed the sheet
      return new PasskeyCeremonyError("Cancelled.", true);
    case "NotAllowedError":
      // covers both "user dismissed" and "timed out", which the spec
      // deliberately makes indistinguishable so a site can't probe for
      // whether a credential exists
      return new PasskeyCeremonyError("Cancelled, or the request timed out.", true);
    case "InvalidStateError":
      // excludeCredentials matched — this authenticator already holds a
      // credential for this account
      return new PasskeyCeremonyError(
        "This passkey is already registered on your account.",
        false,
      );
    case "SecurityError":
      // the page's origin doesn't match the relying party — in practice,
      // reaching the dashboard over a LAN IP instead of localhost
      return new PasskeyCeremonyError(
        "This site's address doesn't match the passkey.",
        false,
      );
    case "NotSupportedError":
      return new PasskeyCeremonyError(
        "This device can't create a passkey.",
        false,
      );
    default:
      return new PasskeyCeremonyError("Couldn't complete — try again.", false);
  }
}

// `optionsJSON` comes back from the API as an open object: @nestjs/swagger
// can't model PublicKeyCredentialCreationOptionsJSON, so the generated type
// is untyped. The cast is confined to here rather than spread across call
// sites.
export async function runRegistration(
  optionsJSON: unknown,
): Promise<RegistrationResponseJSON> {
  try {
    return await startRegistration({
      optionsJSON: optionsJSON as Parameters<
        typeof startRegistration
      >[0]["optionsJSON"],
    });
  } catch (err) {
    throw normalize(err);
  }
}

// Same cast confinement as runRegistration — the API's options come back as
// an open object because @nestjs/swagger can't model the WebAuthn types.
export async function runAuthentication(
  optionsJSON: unknown,
): Promise<AuthenticationResponseJSON> {
  try {
    return await startAuthentication({
      optionsJSON: optionsJSON as Parameters<
        typeof startAuthentication
      >[0]["optionsJSON"],
    });
  } catch (err) {
    throw normalize(err);
  }
}
