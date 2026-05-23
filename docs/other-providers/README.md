# OIDC providers — overview

The operator UI works with **any** OIDC-compliant Identity Provider that
supports Authorization Code + PKCE for confidential clients. Authentik is
the default and best-documented provider (see
[`../authentik-setup.md`](../authentik-setup.md)), but we ship drop-in
guides for several others:

- [Keycloak](keycloak.md)
- [Auth0](auth0.md)
- [Google](google.md) — for personal/test use; group authorization is awkward
- [Dex](dex.md) — lightweight self-hosted alternative
- [Generic OIDC checklist](generic-oidc.md) — any other compliant IdP

## Switching providers

Set generic env vars and the operator backend will use them in place of
the `AUTHENTIK_*` vars:

```sh
OIDC_PROVIDER_NAME=Keycloak
OIDC_ISSUER=https://keycloak.example.com/realms/booth
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_REDIRECT_URI=https://operator.example.com/v1/auth/callback
OIDC_POST_LOGOUT_REDIRECT_URI=https://operator.example.com
OIDC_SCOPES="openid email profile offline_access groups"
OIDC_ALLOWED_GROUPS=telephone-booth-operators
OIDC_ALLOWED_EMAILS=
```

`OIDC_PROVIDER_NAME` only drives UI copy — the login button reads
"Sign in with $name" and links to the appropriate provider-specific doc
in the UI's help drawer.

## Authorization claims

The backend enforces `OIDC_ALLOWED_GROUPS` against the standard `groups` claim
and `OIDC_ALLOWED_EMAILS` against the `email` claim. Providers that use a
custom group claim should map it to `groups` in the ID token or userinfo. If
both allow-lists are set, both checks must pass.
