# syntax=docker/dockerfile:1

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo

RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/engine/package.json packages/engine/package.json
COPY packages/schema/package.json packages/schema/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile

COPY packages/engine packages/engine
COPY packages/schema packages/schema
COPY apps/api apps/api
COPY apps/web apps/web

ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter @budget/web build

# ---- runtime ----------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
# A typo in nginx.conf fails the build — while the running web container is
# still up — instead of crash-looping the new one after it replaced it.
RUN nginx -t

EXPOSE 80
