# Builds the API bundle and the web UI into one image; the API serves the static UI.
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @meridian/web build && pnpm --filter @meridian/api build

FROM ${NODE_IMAGE}
RUN corepack enable
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
# Runtime dependencies only (native argon2, postgres driver, fastify).
RUN pnpm install --frozen-lockfile --prod --filter @meridian/api
ENV NODE_ENV=production
# Run as the unprivileged `node` user (uid 1000); /app stays owned by root, so the app cannot change it.
USER node
# Inside a container the API has to listen on every interface (outside Docker it binds loopback).
ENV API_HOST=0.0.0.0
ENV WEB_DIST_DIR=/app/apps/web/dist
ENV MERIDIAN_MIGRATIONS_DIR=/app/packages/db/drizzle
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
