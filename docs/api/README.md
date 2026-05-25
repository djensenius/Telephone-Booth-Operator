# API documentation

The operator API is described by an OpenAPI 3.1 spec at
[`packages/api/openapi.yaml`](../../packages/api/openapi.yaml). That file
is the contract between:

- the operator backend (which serves the routes),
- the operator frontend (typed via `openapi-typescript`),
- the Rust phone client (which generates a typed client from the same
  spec under `crates/booth-pi/build.rs` when the `pi` feature is
  enabled),
- and **anyone integrating** (you).

## Reading the spec

GitHub renders OpenAPI YAML; you can also paste it into:

- [Scalar API reference](https://scalar.com)
- [Stoplight Elements](https://stoplight.io/open-source/elements)
- [Swagger Editor](https://editor.swagger.io)

In production the spec is served at `https://operator.example.com/v1/openapi.yaml`
and an embedded Scalar UI at `https://operator.example.com/v1/docs`.

## Regenerating the TS client

```sh
just openapi-gen
```

This runs:

```sh
openapi-typescript packages/api/openapi.yaml -o packages/web/src/api/schema.gen.ts
```

The generated file is `.gitignore`d; the dev server regenerates it on
boot, and CI regenerates it as part of `vp run -r build`.

## Versioning

All paths live under `/v1`. The version bumps when a backward-incompatible
change ships. `openapi-sync.yml` in CI runs `oasdiff` against the
previous version on every PR; breaking changes get flagged and require
either a `/v2` path or a deliberate ADR.

## Security schemes

The spec declares two:

- `apiToken` — HTTP Bearer for the phone client.
- `operatorSession` — `__Host-booth_session` cookie set after Authentik OIDC login.

Every operation declares which one(s) it accepts. Routes with `security: []`
are public (health check, login endpoints, and read-only `GET /v1/status`).

## Implemented backend routes

The Hono API now serves questions, messages, status, upload-SAS issuance, and
status WebSocket routes. Phone-client writes use Bearer API tokens; operator UI
management routes use the session cookie.

```sh
# Phone: push current booth state
curl -X PUT "$PUBLIC_API_URL/v1/status" \
  -H "Authorization: Bearer $PHONE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"state":"recording"}'

# Phone: get a random question
curl "$PUBLIC_API_URL/v1/questions/random" \
  -H "Authorization: Bearer $PHONE_API_TOKEN"

# Phone: initiate and complete a message upload
curl -X POST "$PUBLIC_API_URL/v1/messages" \
  -H "Authorization: Bearer $PHONE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"durationMs":12000,"sha256":"<64 lowercase hex>"}'
curl -X POST "$PUBLIC_API_URL/v1/messages/<id>/complete" \
  -H "Authorization: Bearer $PHONE_API_TOKEN"

# Operator: list recent messages using the browser session cookie
curl "$PUBLIC_API_URL/v1/messages?status=received&limit=25" \
  -H 'Cookie: __Host-booth_session=<signed-session>'
```
