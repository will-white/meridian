ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @meridian/worker build

# Runtime dependencies only, installed in a stage of their own so that pnpm, its store and its
# cache stay out of the image. pnpm's links inside node_modules are relative, so they survive
# the copy below.
FROM ${NODE_IMAGE} AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile --prod --filter @meridian/worker

# The image: the bundle (with its source map) and the runtime dependencies. No migrations: the
# API applies them at boot, and the worker starts after the API is healthy. Nothing is installed
# or run here.
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
# The workspace links in node_modules point at these two folders.
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
ENV NODE_ENV=production
# Logged stack traces name the source file and line.
ENV NODE_OPTIONS=--enable-source-maps
# Run as the unprivileged `node` user (uid 1000); /app stays owned by root, so the app cannot change it.
USER node
CMD ["node", "apps/worker/dist/main.js"]
