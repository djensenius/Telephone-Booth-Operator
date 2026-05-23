# Telephone-Booth-Operator developer recipes.
# Run `just` with no args to list available recipes.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    @just --list

# Install dependencies (Node packages only; use `mise install` for tools).
setup:
    pnpm install --frozen-lockfile

# Run the full local stack: containers + api + web.
dev:
    docker compose up -d
    pnpm -r --parallel run dev

# Stop containers.
down:
    docker compose down

# Apply Prisma migrations against the local Postgres.
db-migrate:
    pnpm --filter @telephone-booth-operator/api exec prisma migrate dev

# Reset and seed the local database with sample data.
db-seed:
    pnpm --filter @telephone-booth-operator/api exec tsx ../../tools/seed.ts

# Typecheck every package.
typecheck:
    pnpm -r typecheck

# Lint every package.
lint:
    pnpm -r lint
    markdownlint-cli2 'docs/**/*.md' 'README.md'

# Format every package.
fmt:
    pnpm -r run format

# Run all tests.
test:
    pnpm -r test

# fmt + lint + typecheck + test
check: fmt lint typecheck test

# Regenerate the typed API client from packages/api/openapi.yaml.
openapi-gen:
    pnpm --filter @telephone-booth-operator/web exec openapi-typescript \
        ../api/openapi.yaml -o src/api/schema.gen.ts

# Run end-to-end Playwright tests against a running stack.
e2e:
    pnpm --filter @telephone-booth-operator/web exec playwright test

# Build production docker images and tag them locally.
docker-build:
    docker build -f packages/api/Dockerfile -t telephone-booth-operator-api:dev .
    docker build -f packages/web/Dockerfile -t telephone-booth-operator-web:dev .

# Lint every docs link (intra-doc).
docs-check:
    markdownlint-cli2 'docs/**/*.md' 'README.md'
    lychee --offline --no-progress 'docs/**/*.md' 'README.md'

# Rebuild the docs/README.md index from the docs/ tree.
docs-index:
    pnpm exec tsx tools/build-docs-index.ts
