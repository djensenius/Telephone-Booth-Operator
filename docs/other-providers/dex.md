# Dex setup

[Dex](https://dexidp.io) is a lightweight, self-hosted IdP that brokers
to upstream sources (GitHub, LDAP, Microsoft, etc.). It's a nice
alternative if you don't want to run a full Authentik or Keycloak.

## 1. Client config (Dex side)

In `dex-config.yaml`:

```yaml
staticClients:
  - id: telephone-booth-operator
    name: Telephone Booth Operator
    secret: replace-me-with-a-strong-secret
    redirectURIs:
      - http://localhost:8787/v1/auth/callback
      - https://operator.example.com/v1/auth/callback
```

Make sure the upstream connector you configure (`github`, `ldap`, etc.)
exposes group membership — Dex passes them through unchanged on the
`groups` claim.

For GitHub:

```yaml
connectors:
  - type: github
    id: github
    name: GitHub
    config:
      clientID: $GITHUB_CLIENT_ID
      clientSecret: $GITHUB_CLIENT_SECRET
      redirectURI: https://dex.example.com/callback
      orgs:
        - name: your-org
          teams:
            - telephone-booth-operators
      loadAllGroups: false
      useLoginAsID: false
```

Dex will then emit `groups: ["your-org:telephone-booth-operators"]`.

## 2. `.env`

```ini
OIDC_PROVIDER_NAME=Dex
OIDC_ISSUER=https://dex.example.com
OIDC_CLIENT_ID=telephone-booth-operator
OIDC_CLIENT_SECRET=replace-me-with-a-strong-secret
OIDC_REDIRECT_URI=http://localhost:8787/v1/auth/callback
OIDC_REQUIRED_GROUP=your-org:telephone-booth-operators
OIDC_GROUPS_CLAIM=groups
OIDC_GROUPS_SCOPE=groups
```

Note that `OIDC_REQUIRED_GROUP` includes the GitHub org prefix because
that's how Dex emits the value. Match the format your connector produces.

## 3. Verify

`just dev` → log in via Dex → bounce out to GitHub → bounce back. The
operator UI should land on Status with your GitHub display name.
