# Auth0 setup

## 1. Application

> _Auth0 dashboard → Applications → Create application_ →
> **Regular Web Application** → Auth0 Quick Start: skip.

| Setting              | Value                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| Allowed Callback URLs| `http://localhost:8787/v1/auth/callback`<br>`https://operator.example.com/v1/auth/callback` |
| Allowed Logout URLs  | `http://localhost:5173`, prod equivalent                              |
| Token Endpoint Auth  | `Post`                                                                |

Copy **Domain**, **Client ID**, and **Client Secret**.

## 2. Group claim

Auth0 doesn't put groups in tokens by default. Use a Post-Login Action
(formerly Rules) to inject them:

```js
exports.onExecutePostLogin = async (event, api) => {
  const groups = (event.user.app_metadata && event.user.app_metadata.groups) || [];
  api.idToken.setCustomClaim("groups", groups);
};
```

Then populate `app_metadata.groups` for the user(s) you want to grant
access — e.g. `["telephone-booth-operators"]`.

## 3. `.env`

```ini
OIDC_PROVIDER_NAME=Auth0
OIDC_ISSUER=https://YOUR_TENANT.auth0.com/
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_REDIRECT_URI=http://localhost:8787/v1/auth/callback
OIDC_SCOPES="openid email profile offline_access"
OIDC_ALLOWED_GROUPS=telephone-booth-operators
```

Note the trailing slash on `OIDC_ISSUER` — Auth0 issuers are slash-terminated.

## 4. Verify

`just dev` → log in. The ID token should now contain the namespaced
`groups` claim, and the operator UI will honor it.
