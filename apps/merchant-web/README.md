# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Testing passkeys locally

Passkeys need a real authenticator, so use Chrome's virtual one rather than
your laptop's Touch ID — it lets you register and sign in repeatedly without
accumulating credentials on the machine.

DevTools → ⋮ → More tools → **WebAuthn** → tick *Enable virtual authenticator
environment*, then add an authenticator with:

| Setting | Value |
|---|---|
| Protocol | `ctap2` |
| Transport | `internal` |
| Supports resident keys | **on** |
| Supports user verification | **on** |

Both toggles are required, not optional. The API asks for
`residentKey: "required"` (so the credential can identify its user for
usernameless sign-in) and `userVerification: "required"` (so a passkey counts
as two factors rather than possession alone) — an authenticator without them
fails the ceremony in a way that looks like a bug in the app.

Registered credentials show up in that same panel, so you can delete them
between runs.

### Two gotchas

**WebAuthn needs a secure context.** `http://localhost:5000` qualifies, but
reaching the dashboard over a LAN IP — `http://192.168.x.x:5000`, e.g. from a
phone — does not, and fails with a browser error that doesn't explain why.
Use a tunnel with a real hostname if you need to test on a device.

**The relying-party ID is derived from `MERCHANT_WEB_URL`** (see
`apps/merchant-api/src/identity/auth/webauthn.config.ts`), so it's `localhost`
in dev. Credentials registered against one RP ID don't work against another —
passkeys made locally will never work in production, and that's expected.
