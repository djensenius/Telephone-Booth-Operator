# Keycloak setup

Equivalent of [`../authentik-setup.md`](../authentik-setup.md) for
[Keycloak](https://www.keycloak.org).

## 1. Realm + group

> _Keycloak admin → Realm settings → Create realm_ (or use an existing one).
> _Groups → Create group_ → `telephone-booth-operators`. Add your user.

## 2. Client

> _Clients → Create client_

| Field                 | Value                                                     |
| --------------------- | --------------------------------------------------------- |
| Client type           | OpenID Connect                                            |
| Client ID             | `telephone-booth-operator`                                |
| Client authentication | **On** (confidential)                                     |
| Valid redirect URIs   | `http://localhost:8787/v1/auth/callback`, prod equivalent |
| Standard flow         | **On** (Authorization Code)                               |
| Direct access grants  | Off                                                       |

Save. Under **Credentials** copy the client secret.

## 3. Map the groups claim

Keycloak doesn't include `groups` in the ID token by default.

> _Client → Client scopes → `telephone-booth-operator-dedicated` →
> Add mapper → By configuration → Group Membership_

| Field               | Value                                                    |
| ------------------- | -------------------------------------------------------- |
| Name                | `groups`                                                 |
| Token Claim Name    | `groups`                                                 |
| Full group path     | **Off** (so values are just `telephone-booth-operators`) |
| Add to ID token     | **On**                                                   |
| Add to userinfo     | **On**                                                   |
| Add to access token | optional                                                 |

## 4. `.env`

```ini
OIDC_PROVIDER_NAME=Keycloak
OIDC_ISSUER=https://keycloak.example.com/realms/<realm>
OIDC_CLIENT_ID=telephone-booth-operator
OIDC_CLIENT_SECRET=<from Credentials>
OIDC_REDIRECT_URI=http://localhost:8787/v1/auth/callback
OIDC_SCOPES="openid email profile offline_access"
OIDC_ALLOWED_GROUPS=telephone-booth-operators
```

Confirm by curling `${OIDC_ISSUER}/.well-known/openid-configuration`.

## 5. Verify

`just dev` → log in → confirm name + group are populated. If groups are
missing, double-check the mapper from step 3 is attached to the client.
