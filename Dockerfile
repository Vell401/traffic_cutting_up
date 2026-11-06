# syntax=docker/dockerfile:1
# One build, two images: the game server (Node) and the site behind Caddy (HTTPS, /ws proxy).
# compose.yaml builds both targets; the deploy workflow runs it on the VPS.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
# A commit that does not typecheck or fails a test stops here and never reaches the server.
RUN npm run typecheck && npx vitest run && npm run build && npm run build:server

FROM node:22-alpine AS server
WORKDIR /app
ENV NODE_ENV=production
# The server bundle needs only `ws` at run time (no dependencies of its own).
COPY --from=build /app/node_modules/ws ./node_modules/ws
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist-server/main.js"]

FROM caddy:2-alpine AS web
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
