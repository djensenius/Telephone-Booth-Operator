# Mobile clients (Authentik native-app PKCE)

This doc walks through registering a native/mobile application against the
same Authentik provider the browser operator console uses, so that the
[`Telephone-Booth-Operator-Mobile`](https://github.com/djensenius/Telephone-Booth-Operator-Mobile)
app (and any future native client) can call the same `/v1/*` operator API.

The operator API validates an Authentik-issued **JWT access token** via the
provider's JWKS, the issuer, the audience (operator web `client_id` plus any
`OIDC_MOBILE_AUDIENCES` you configure), and the operator group / email
allow-list (`OIDC_ALLOWED_GROUPS`, `OIDC_ALLOWED_EMAILS`). The middleware
lives in `packages/api/src/lib/bearer-auth.ts` and is invoked from
`requireOperator()` as a fallback when no cookie session is present.

## 1. Create a native application + provider in Authentik

In Authentik admin → **Applications** → **Create**:

- **Name:** `Telephone-Booth Operator Mobile`
- **Slug:** `telephone-booth-operator-mobile`
- **Provider:** Create a new OAuth2/OpenID provider with:
  - **Client type:** `Public` (so no client secret is required — required for
    PKCE-only native flows; the mobile app cannot safely store a secret).
  - **Client ID:** `telephone-booth-operator-mobile` (this is what you'll
    add to `OIDC_MOBILE_AUDIENCES` on the operator).
  - **Redirect URIs:** `tboperator://oauth/callback` (the URL scheme the
    mobile app registers with the OS). Additional schemes can be added if
    you want different bundle IDs for dev vs prod.
  - **PKCE:** `Required`.
  - **Scopes:** `openid profile email offline_access`.
  - **Subject mode:** `Based on the User's hashed ID` (or any stable identifier
    — the operator stores it as `OperatorUser.oidcSub`).
  - **Signing Key:** Use the same RSA key the existing operator provider uses
    so the JWKS endpoint validates both tokens; alternately, host a separate
    JWKS endpoint and update `OIDC_ISSUER` accordingly (single-issuer is the
    common setup).
  - **Issuer mode:** Match the same `OIDC_ISSUER` the operator API expects.
- **Bindings / Groups:** restrict access to the same `telephone-booth-operators`
  group used by the web client (or whichever value you've set in
  `OIDC_ALLOWED_GROUPS`).

The mobile app sends the access token directly to the operator API, so the
mobile provider must include the same `groups` claim in the **access token**
that the web provider includes in the ID token. Authentik's default
`profile` scope mapping includes group membership. If you've removed it,
add a scope mapping on `profile`:

```python
return {"groups": [group.name for group in user.groups.all()]}
```

That expression returns all group names for the signed-in user. The operator
still only grants access when at least one returned group matches
`OIDC_ALLOWED_GROUPS`, typically `telephone-booth-operators`.

## 2. Configure the operator API

Add the new client_id to the bearer-audience allow-list:

```bash
# packages/api/.env (or your deployment secret store)
OIDC_MOBILE_AUDIENCES=telephone-booth-operator-mobile
```

Restart the API. The operator now accepts:

- Cookie sessions issued by the existing web flow.
- `Authorization: Bearer <jwt>` headers carrying access tokens whose `aud`
  is **either** `OIDC_CLIENT_ID` (web) **or** any entry in
  `OIDC_MOBILE_AUDIENCES`.

No additional CORS configuration is required — native HTTP clients do not
send `Origin` headers and therefore bypass the browser CORS allow-list.

## 3. Mobile-side flow (informational)

The mobile app uses `ASWebAuthenticationSession` (or the platform equivalent)
to drive the full OIDC PKCE Authorization-Code grant:

1. App generates `code_verifier` + `code_challenge=S256(code_verifier)`.
2. App opens `https://authentik.example/application/o/authorize/?...` with
   `response_type=code`, `client_id=telephone-booth-operator-mobile`,
   `redirect_uri=tboperator://oauth/callback`, `scope=openid profile email
offline_access`, `code_challenge`, `code_challenge_method=S256`,
   `state`, `nonce`.
3. User authenticates in the system browser; Authentik redirects back to
   `tboperator://oauth/callback?code=...&state=...`.
4. App exchanges the code at the token endpoint with the same
   `client_id` + `code_verifier` (no client secret).
5. App stores `access_token`, `id_token`, `refresh_token` in the platform
   Keychain (per-target access group) and uses
   `Authorization: Bearer <access_token>` for every `/v1/*` request.
6. App refreshes silently via the `refresh_token` before `expires_in`
   expires. On unrecoverable refresh failure the app drops the keychain
   entry and routes the user back to the sign-in screen.

## 4. Troubleshooting

| Symptom                          | Likely cause                                                         |
| -------------------------------- | -------------------------------------------------------------------- |
| `401 invalid_token` from `/v1/*` | Token expired, audience mismatch, or signed by an unknown JWKS key.  |
| `403` from `/v1/*` after sign-in | Authenticated principal isn't in `OIDC_ALLOWED_GROUPS`.              |
| Sign-in completes but app loops  | App's URL scheme not registered, or Authentik redirect URI mismatch. |
| `aud` mismatch only in mobile    | `OIDC_MOBILE_AUDIENCES` not set / restart pending on the API.        |

To inspect a failing token locally, paste it into <https://jwt.io> or run
`jose.decodeJwt(token)` in a Node REPL — the API only logs failure reasons
in non-prod environments to avoid leaking token contents.
