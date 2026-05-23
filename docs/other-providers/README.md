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
OIDC_REQUIRED_GROUP=telephone-booth-operators
OIDC_GROUPS_CLAIM=groups
OIDC_GROUPS_SCOPE=groups
```

`OIDC_PROVIDER_NAME` only drives UI copy — the login button reads
"Sign in with $name" and links to the appropriate provider-specific doc
in the UI's help drawer.

## Group claim names

Different providers expose group membership under different claim names:

| Provider  | Default claim name                        |
| --------- | ----------------------------------------- |
| Authentik | `groups`                                  |
| Keycloak  | `groups` (after mapper) or `realm_access.roles` |
| Auth0     | `https://your-namespace/groups` (custom rule) |
| Google    | _not supported natively; use a Workspace Directory API sync_ |
| Dex       | `groups`                                  |

Set `OIDC_GROUPS_CLAIM` to the path the claim sits at. Dotted paths are
supported (`OIDC_GROUPS_CLAIM=realm_access.roles`).
