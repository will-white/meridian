# Builds both the API (dist) and the web UI (static) into one image served by the API.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @meridian/web build && pnpm --filter @meridian/api build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app ./
RUN pnpm prune --prod
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
