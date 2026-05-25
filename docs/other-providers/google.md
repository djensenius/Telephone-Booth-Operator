# Google as the OIDC provider

Google works for personal / single-user installs. **Group authorization
is awkward** because Google doesn't expose group membership in the ID
token; you'd need a Workspace Directory API sync job, which is out of
scope for this project.

Use Google when:

- You're the only operator (skip group checks by setting
  `OIDC_REQUIRED_GROUP=""`, see "Single-user mode" below).
- You're prototyping and want zero IdP infrastructure.

For multi-operator deploys, use Authentik / Keycloak / Auth0.

## 1. OAuth client

> _Google Cloud console → APIs & Services → Credentials → Create
> credentials → OAuth client ID_

| Setting                  | Value                                                     |
| ------------------------ | --------------------------------------------------------- |
| Application type         | Web application                                           |
| Authorized redirect URIs | `http://localhost:8787/v1/auth/callback`, prod equivalent |

Copy the Client ID + Client Secret.

## 2. `.env`

```ini
OIDC_PROVIDER_NAME=Google
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=...apps.googleusercontent.com
OIDC_CLIENT_SECRET=...
OIDC_REDIRECT_URI=http://localhost:8787/v1/auth/callback
OIDC_SCOPES="openid email profile"
OIDC_ALLOWED_GROUPS=
```

## 3. Single-user mode

When `OIDC_ALLOWED_GROUPS` is empty, the operator backend falls back to
allow-listing by email. Set:

```ini
OIDC_ALLOWED_EMAILS=you@example.com,you+alt@example.com
```

The backend rejects any login whose email is outside the allow-list with a
"Not authorized for this booth" screen.
