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

FROM ${NODE_IMAGE}
RUN corepack enable
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile --prod --filter @meridian/worker
ENV NODE_ENV=production
# Run as the unprivileged `node` user (uid 1000); /app stays owned by root, so the app cannot change it.
USER node
ENV MERIDIAN_MIGRATIONS_DIR=/app/packages/db/drizzle
CMD ["node", "apps/worker/dist/main.js"]
