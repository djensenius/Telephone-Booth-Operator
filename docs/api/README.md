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
boot, and CI regenerates it as part of `pnpm -r build`.

## Versioning

All paths live under `/v1`. The version bumps when a backward-incompatible
change ships. `openapi-sync.yml` in CI runs `oasdiff` against the
previous version on every PR; breaking changes get flagged and require
either a `/v2` path or a deliberate ADR.

## Security schemes

The spec declares two:

- `apiToken` — HTTP Bearer for the phone client.
- `operatorSession` — `tbo_session` cookie set after Authentik OIDC login.

Every operation declares which one(s) it accepts. Routes with `security: []`
are public (health check, login endpoints).
