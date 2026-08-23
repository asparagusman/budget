# syntax=docker/dockerfile:1

# ---- deps + build ---------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo

RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/engine/package.json packages/engine/package.json
COPY packages/schema/package.json packages/schema/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/engine packages/engine
COPY packages/schema packages/schema
COPY apps/api apps/api

RUN pnpm --filter @budget/api... build

# tsup bundles apps/api's own code plus @budget/schema and @budget/engine,
# but the externalized npm deps (pg, hono, etc.) still need a real
# node_modules. `pnpm deploy` resolves the workspace:* dependency into an
# actual pruned, prod-only node_modules — this is what turns
# "workspace:*" into something a plain `node` can run outside the monorepo.
RUN pnpm --filter @budget/api deploy --prod --legacy /tmp/deploy

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /tmp/deploy/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json

EXPOSE 3001
CMD ["node", "dist/index.js"]
