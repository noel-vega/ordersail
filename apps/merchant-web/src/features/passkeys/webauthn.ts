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

// The API publishes the ceremony options as an open object, because
// @nestjs/swagger can't model PublicKeyCredentialCreationOptionsJSON and
// openapi-typescript renders any attempt at it as Record<string, never>.
// Hand-writing a DTO to mirror a browser-spec type would produce types that
// can silently disagree with what @simplewebauthn actually emits, which is
// worse than an honest `unknown` — a type that lies is harder to debug than
// a cast you can see.
//
// So the cast stays, confined to these two functions, but it is CHECKED:
// every ceremony's options must carry a string `challenge`, and failing
// here gives a readable error at the boundary instead of an opaque
// DOMException from deep inside the browser API.
function assertCeremonyOptions(optionsJSON: unknown, kind: string): void {
  const challenge =
    typeof optionsJSON === "object" &&
    optionsJSON !== null &&
    "challenge" in optionsJSON
      ? (optionsJSON as { challenge: unknown }).challenge
      : undefined;
  if (typeof challenge !== "string" || !challenge) {
    throw new PasskeyCeremonyError(
      `The server sent something unexpected for ${kind}. Try again.`,
      false,
    );
  }
}

export async function runRegistration(
  optionsJSON: unknown,
): Promise<RegistrationResponseJSON> {
  assertCeremonyOptions(optionsJSON, "registration");
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

// Same checked cast as runRegistration.
export async function runAuthentication(
  optionsJSON: unknown,
): Promise<AuthenticationResponseJSON> {
  assertCeremonyOptions(optionsJSON, "sign-in");
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
