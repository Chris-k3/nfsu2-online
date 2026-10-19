# syntax=docker/dockerfile:1
# NFS Underground 2 in the browser: the server as a container image (docs/web/DOCKER.md).
#
#   docker build -t nfsu2-web .
#
# The image holds what web/deploy/pack.sh's bundle holds minus the game module: the server, its one dependency
# (ws) and the page (web/dist, without the test pages and source maps).  It never holds the game or anything made
# from it (.dockerignore lets only the server's and the page's sources into the build); those are mounted:
#   /game     the NFS Underground 2 folder (the one with SPEED2.EXE), read-only, readable by everyone
#   /module   nfsu2.wasm and nfsu2.json, built with web/build.sh from the image's revision, read-only
#   /state    the server's keys (ETags, the switch's tokens) and the Online mode's records: a volume, kept
#             across updates (a new ETag key would make every browser download the game data again)
# The server runs as the unprivileged user node and listens on 127.0.0.1:8080 of the network it is given: the
# VPS's own, with Caddy in front (web/deploy/compose.yml), or a tunnel's (compose.tunnel.yml).  Its command line
# is the server's options (web/server/server.mjs); by default --behind-proxy, which needs NFSU2_HOST, the name
# players open.
#
# The page and the dependency are built on the build machine's platform (plain JavaScript); the image's own
# stage only copies, so building it for another platform needs no emulation.
FROM --platform=$BUILDPLATFORM node:24-alpine AS page
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/registry-defaults.txt /src/app/
COPY web/build.mjs web/index.html ./
COPY web/src src
RUN node build.mjs && mkdir /state

FROM --platform=$BUILDPLATFORM node:24-alpine AS deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
LABEL org.opencontainers.image.title="nfsu2-web" \
      org.opencontainers.image.description="NFS Underground 2 in the browser: the server (bring your own game)" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=deps /app/web/node_modules web/node_modules
COPY --from=page /src/web/dist web/dist
COPY web/server web/server
COPY --from=page --chown=node:node --chmod=700 /state /state
ENV NFSU2_DATA=/game \
    NFSU2_WASM=/module/nfsu2.wasm \
    NFSU2_STATE=/state \
    NFSU2_MAX_PEERS=250
USER node
VOLUME /state
# the module is there and the server answers (over the HTTP port, which stays on 127.0.0.1)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${NFSU2_HTTP_PORT:-8080}/game.json" || exit 1
ENTRYPOINT ["node", "/app/web/server/server.mjs"]
CMD ["--behind-proxy"]
