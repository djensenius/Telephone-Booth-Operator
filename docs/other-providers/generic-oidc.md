# Generic OIDC checklist

If your IdP isn't listed in this directory, here's what it needs to do
for the operator UI to work:

## Required

- [ ] **Discovery endpoint** at `${OIDC_ISSUER}/.well-known/openid-configuration`.
- [ ] **Authorization Code flow with PKCE** for confidential clients.
- [ ] **JWKS endpoint** returning the keys the backend should use to
      validate ID-token signatures.
- [ ] **`openid` `profile` `email`** scopes supported.
- [ ] A way to expose **group / role membership** in either the ID token
      or the userinfo response.

## Configurable on the operator backend

| Env var                | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `OIDC_PROVIDER_NAME`   | UI copy. e.g. "Sign in with $name".                            |
| `OIDC_ISSUER`          | Discovery base URL.                                            |
| `OIDC_CLIENT_ID`       | Client ID issued by your IdP.                                  |
| `OIDC_CLIENT_SECRET`   | Client secret.                                                 |
| `OIDC_REDIRECT_URI`    | Must match what you registered on the IdP, exactly.            |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | Where to send browsers after local/IdP logout.        |
| `OIDC_SCOPES`          | Scope string to request. Default `openid email profile offline_access`. |
| `OIDC_ALLOWED_GROUPS`  | Optional CSV. If set, the `groups` claim must intersect.       |
| `OIDC_ALLOWED_EMAILS`  | Optional CSV. If set, the `email` claim must be listed.        |

When the **`OIDC_*` vars are set, they override their `AUTHENTIK_*`
counterparts**; that lets you keep both blocks in `.env` and toggle by
commenting one out.

## Smoke-test checklist

```sh
# 1. Discovery JSON returns a JSON document with the expected endpoints.
curl -fs "$OIDC_ISSUER/.well-known/openid-configuration" | jq .

# 2. A test auth round-trip succeeds.
just dev
# → click "Sign in with $OIDC_PROVIDER_NAME" → complete IdP flow.

# 3. /v1/auth/me returns the expected groups + sub.
curl -fs -b cookies.txt http://localhost:8787/v1/auth/me | jq .
```

If the third step shows `groups: []`, your IdP isn't sending a standard
`groups` claim. Map provider-specific group or role data into `groups` and
try again.

## When to give up and use a documented provider

Authentik is the path of least resistance. If your IdP doesn't have a
clean groups claim or you'd rather not maintain custom mappers, run
Authentik beside your existing IdP and federate them — Authentik can
broker SAML / LDAP / OIDC upstream and present a single OIDC client to
the operator backend.
