# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/api/package.json packages/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @telephone-booth-operator/api exec prisma generate \
 && pnpm --filter @telephone-booth-operator/api... build

FROM node:24-alpine AS runtime
WORKDIR /app/packages/api
ENV NODE_ENV=production
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/api/node_modules /app/packages/api/node_modules
COPY --from=build /app/packages/api/dist /app/packages/api/dist
COPY --from=build /app/packages/api/package.json /app/packages/api/
COPY --from=build /app/packages/api/prisma /app/packages/api/prisma
COPY --from=build /app/packages/shared /app/packages/shared
EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]
