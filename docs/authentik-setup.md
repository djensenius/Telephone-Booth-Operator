# Authentik setup

Authentik is the default operator-UI authentication provider. This guide
walks you through the full setup. For other OIDC providers, see
[`other-providers/`](other-providers/).

If you don't already run Authentik, the project's
[installation docs](https://docs.goauthentik.io/docs/install-config/install/docker-compose)
have a docker-compose quickstart.

## 1. Create the group

> _Authentik admin UI → Directory → Groups → Create_

| Field   | Value                          |
| ------- | ------------------------------ |
| Name    | `telephone-booth-operators`    |
| Members | Add your user (and any others) |

The operator UI authorizes by group membership, so adding more humans
later is a no-code change.

## 2. Create the OAuth2 / OpenID provider

> _Applications → Providers → Create → OAuth2/OpenID Provider_

| Field                    | Value                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| Name                     | `telephone-booth-operator`                                            |
| Authorization flow       | `default-authorization-flow (Authorize Application)`                  |
| Client type              | **Confidential**                                                      |
| Client ID                | _auto-generated; copy it_                                             |
| Client Secret            | _auto-generated; copy it_                                             |
| Redirect URIs            | `http://localhost:8787/v1/auth/callback`<br>`https://operator.example.com/v1/auth/callback` (prod) |
| Signing Key              | _default (RSA)_                                                       |
| Subject mode             | **Based on the User's hashed ID** (stable, opaque `sub`)              |
| Include claims in id_token | **Yes**                                                             |
| Scopes                   | `openid` `profile` `email` `goauthentik.io/api`                       |

Save. You'll also want to make sure the **Group Membership** property
mapping is included in your scopes — Authentik exposes a `groups` claim
by default in the `goauthentik.io/api` scope. If you've trimmed it, add
a custom mapping:

```python
# Authentik: Customization → Property Mappings → Create → Scope Mapping
# Name:  oidc-groups
# Scope name: groups
# Expression:
return {"groups": [group.name for group in user.ak_groups.all()]}
```

Then attach `oidc-groups` to the provider's scopes.

## 3. Create the application

> _Applications → Applications → Create_

| Field       | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Name        | `Telephone Booth Operator`                                                            |
| Slug        | `telephone-booth-operator`                                                            |
| Provider    | `telephone-booth-operator` (from step 2)                                              |
| Launch URL  | `https://operator.example.com` (or `http://localhost:5173` for dev)                   |

### Policy bindings (belt-and-suspenders authorization)

Under the application → **Policy / Group / User Bindings**, bind the
`telephone-booth-operators` group. This makes Authentik refuse the
authorize step server-side for users outside the group, so a misconfigured
operator backend can't accidentally grant access.

## 4. Populate `.env`

Copy `.env.example` to `.env` and fill in:

```ini
OIDC_PROVIDER_NAME=Authentik
AUTHENTIK_ISSUER=https://authentik.example.com/application/o/telephone-booth-operator/
AUTHENTIK_CLIENT_ID=<from step 2>
AUTHENTIK_CLIENT_SECRET=<from step 2>
AUTHENTIK_REDIRECT_URI=http://localhost:8787/v1/auth/callback
AUTHENTIK_REQUIRED_GROUP=telephone-booth-operators
AUTHENTIK_GROUPS_CLAIM=groups
AUTHENTIK_GROUPS_SCOPE=goauthentik.io/api
SESSION_SECRET=<openssl rand -hex 32>
```

> **Issuer URL** is the `/application/o/<slug>/` path on your Authentik
> host. Confirm by hitting `${AUTHENTIK_ISSUER}.well-known/openid-configuration`
> with `curl` — you should get a JSON discovery document.

## 5. Verify

```sh
just dev
```

Open <http://localhost:5173>. Click / drag the receiver to "answer".
You'll bounce to Authentik, then back. Header should now greet you with
your name pulled from the ID token.

## 6. Token rotation playbook

### Rotating the client secret

1. Authentik → Providers → `telephone-booth-operator` → **Regenerate
   Client Secret**.
2. Copy the new secret. Update `AUTHENTIK_CLIENT_SECRET` in your
   operator deploy's secrets store.
3. Roll the operator API container. In-flight sessions stay valid
   (they're signed by `SESSION_SECRET`, not the OIDC secret).

### Rotating `SESSION_SECRET`

This **logs everyone out** by invalidating every signed cookie.

1. `openssl rand -hex 32` → new secret.
2. Update the env, roll the container.
3. Operators log back in via Authentik (no re-onboarding required).

## 7. Troubleshooting

| Symptom                                | Likely cause                                              |
| -------------------------------------- | --------------------------------------------------------- |
| `invalid_redirect_uri`                 | Missing entry in step 2; redirect must match exactly      |
| `missing groups claim`                 | Provider isn't including `goauthentik.io/api` scope, or the custom mapping isn't attached |
| `Operator credentials required` screen | User isn't in `telephone-booth-operators`                 |
| `iat` / clock-skew errors              | Pi/server clocks differ; install `chrony` or `systemd-timesyncd` |
| Cookies missing in prod                | Operator UI not served over HTTPS; `Secure` cookies are dropped |

If you've ruled out the above, set `LOG_LEVEL=debug` in the API container
and look at the auth callback handler's structured logs.
