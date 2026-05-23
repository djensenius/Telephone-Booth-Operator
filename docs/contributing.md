# Contributing

## Branches

- `main` is the active branch.
- Feature branches: `<github-username>/<short-topic>`.

## Commits

Conventional Commits preferred but not strictly enforced.

## Before pushing

```sh
just check          # fmt + lint + typecheck + test
just docs-check     # markdownlint + lychee
```

CI runs the same plus typedoc and an OpenAPI diff.

## Adding a new OIDC provider doc

If your provider isn't covered:

1. Add `docs/other-providers/<provider>.md` following the structure of
   the existing files.
2. Link it from `docs/other-providers/README.md` and `docs/README.md`.
3. If the provider needs a quirk in the OIDC code (a non-standard claim
   layout, custom token-endpoint auth, etc.) add it behind an env-var
   feature flag in `packages/api/src/lib/auth.ts` and document the var
   in your guide + `.env.example`.

## Adding a new screen

1. Add the route to `packages/web/src/app/router.ts`.
2. If it should be reachable via the rotary, update `docs/ui-routing.md`
   and the rotary key map in `packages/web/src/features/booth/RotaryDial.tsx`.
3. Wrap the screen body in `<GlassPanel>` to keep the theme consistent.

## Adding an API endpoint

1. Edit `packages/api/openapi.yaml` first. PR with just the spec change
   to surface API design feedback early.
2. Implement the handler in `packages/api/src/routes/`.
3. Regenerate the TS client (`just openapi-gen`).
4. Wire up the frontend.
5. Write a Vitest test covering the happy path and one auth-failure path.

## Style

- TypeScript: `strict: true` everywhere; no `any`. Prefer `unknown` +
  narrowing.
- React: no class components.
- CSS: design tokens from `styles/theme.css` only. No raw hex in
  component CSS.
- ESLint config is shared via the root and is `--max-warnings=0` in CI.
