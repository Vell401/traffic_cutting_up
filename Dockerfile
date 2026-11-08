# syntax=docker/dockerfile:1
# One build, two images: the game server (Node) and the site behind Caddy (HTTPS, /ws proxy).
# compose.yaml builds both targets; the deploy workflow runs it on the VPS.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
# A commit that does not typecheck or fails a test stops here and never reaches the server.
# SKIP_TESTS=1 (the deploy workflow): the workflow's test job has just run the whole suite on this
# commit on GitHub's runners, so the small VPS (2 cores, 2 GB, no swap) does not run it again: the
# suite failed there under that load (Porsche commit) although it passed in CI. By hand it runs here.
ARG SKIP_TESTS=0
RUN npm run typecheck \
  && if [ "$SKIP_TESTS" = 1 ]; then echo "tests: passed in the workflow's test job"; else npx vitest run; fi \
  && npm run build \
  && npm run build:server
# The commit goes in last: an unchanged tree still reuses every layer above.
ARG GIT_SHA=dev
RUN printf '{"version":"%s"}' "$GIT_SHA" > dist/version.json

FROM node:22-alpine AS server
WORKDIR /app
ENV NODE_ENV=production
# The server bundle (and the smoke-test client next to it) needs only `ws` at run time.
COPY --from=build /app/node_modules/ws ./node_modules/ws
COPY --from=build /app/dist-server ./dist-server
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
# The data volume (leaderboard, diagnostics) is created from this directory, owned by the app user.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist-server/main.js"]

FROM caddy:2-alpine AS web
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
