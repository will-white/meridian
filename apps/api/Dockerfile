# Builds the API bundle and the web UI into one image; the API serves the static UI.
ARG NODE_IMAGE=node:22.23.4-alpine
FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @meridian/web build && pnpm --filter @meridian/api build

# Runtime dependencies only (native argon2, postgres driver, fastify), installed in a stage of
# their own so that pnpm, its store and its cache stay out of the image. pnpm's links inside
# node_modules are relative, so they survive the copy below.
FROM ${NODE_IMAGE} AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/retirement/package.json ./packages/retirement/package.json
RUN pnpm install --frozen-lockfile --prod --filter @meridian/api

# The image: the bundles (with their source maps), the UI, the migrations and the runtime
# dependencies. Nothing is installed or run here.
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
# The workspace links in node_modules point at these three folders (the planner's engine is bundled;
# the API runs one path at a time on its own thread and never starts worker threads, seams G11).
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/retirement/package.json ./packages/retirement/package.json
# Applied by the API at boot (apps/api/src/boot.ts).
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
ENV NODE_ENV=production
# Logged stack traces name the source file and line, also for admin.js run with exec or run.
ENV NODE_OPTIONS=--enable-source-maps
# Run as the unprivileged `node` user (uid 1000); /app stays owned by root, so the app cannot change it.
USER node
# Inside a container the API has to listen on every interface (outside Docker it binds loopback).
ENV API_HOST=0.0.0.0
ENV WEB_DIST_DIR=/app/apps/web/dist
ENV MERIDIAN_MIGRATIONS_DIR=/app/packages/db/drizzle
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
