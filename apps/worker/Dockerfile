ARG NODE_IMAGE=node:22.23.4-alpine
FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
# Two bundles: dist/main.js and the simulation thread entry dist/simThread.js (Phase 4), each with
# its source map. The retirement engine is compiled into both from its source.
RUN pnpm --filter @meridian/worker build

# Runtime dependencies only, installed in a stage of their own so that pnpm, its store and its
# cache stay out of the image. pnpm's links inside node_modules are relative, so they survive
# the copy below. The bundles keep every npm package external, so the worker's own dependencies
# include everything the workspace packages compiled into them import at run time
# (@meridian/retirement: zod; @meridian/shared: zod and re2js).
FROM ${NODE_IMAGE} AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/retirement/package.json ./packages/retirement/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile --prod --filter @meridian/worker

# The image: the two bundles (with their source maps) and the runtime dependencies. The job starts
# its simulation threads on dist/simThread.js beside dist/main.js. No migrations: the API applies
# them at boot, and the worker starts after the API is healthy. Nothing is installed or run here.
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
# The workspace links in node_modules point at these three folders.
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/retirement/package.json ./packages/retirement/package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
ENV NODE_ENV=production
# Logged stack traces name the source file and line.
ENV NODE_OPTIONS=--enable-source-maps
# Run as the unprivileged `node` user (uid 1000); /app stays owned by root, so the app cannot change it.
USER node
CMD ["node", "apps/worker/dist/main.js"]
