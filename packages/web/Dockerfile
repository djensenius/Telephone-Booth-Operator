# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
WORKDIR /app
ARG VITE_API_BASE_URL=""
ARG REQUIRE_API_URL="true"
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN if [ "$REQUIRE_API_URL" = "true" ] && [ -z "$VITE_API_BASE_URL" ]; then \
      echo "ERROR: VITE_API_BASE_URL is required but empty. Pass --build-arg REQUIRE_API_URL=false to allow same-origin builds." >&2; \
      exit 1; \
    fi
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/web/package.json packages/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @telephone-booth-operator/web build

FROM nginx:1.27-alpine AS runtime
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
