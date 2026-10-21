# syntax=docker/dockerfile:1
# NFS Underground 2 in the browser: the Rust server (web/server-rs) as a container image.
#
#   docker build -f web/server-rs/Dockerfile -t nfsu2-web-rs .
#
# The Node server's image (Dockerfile) in every way a VPS sees it: the page (web/dist, without the test pages and
# source maps), the mounts (/game the NFS Underground 2 folder, /module nfsu2.wasm and nfsu2.json, /state the keys and
# the Online records), the user (uid 1000, so the state volume the Node image wrote stays writable), the options and
# NFSU2_* environment, the port and the health check.  Only the server differs: one static binary instead of Node.
# So switching a VPS is NFSU2_IMAGE=ghcr.io/<owner>/nfsu2-web-rs:<tag> in its .env (web/deploy/compose.yml), and
# switching back is the old line.  The image never holds the game or anything made from it (this Dockerfile's
# .dockerignore lets only the page's and the server's sources into the build).
#
# Both stages that build run on the build machine's platform: the binary is cross-compiled (cargo-zigbuild, static
# musl) for the image's, so building it for arm64 on amd64 needs no emulation.
FROM --platform=$BUILDPLATFORM node:24-alpine AS page
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/registry-defaults.txt /src/app/
COPY web/build.mjs web/index.html ./
COPY web/src src
COPY web/server/names.mjs server/
RUN node build.mjs && mkdir /state

FROM --platform=$BUILDPLATFORM rust:1-bookworm AS server
ARG TARGETARCH
ARG ZIG=0.14.1
RUN case "$TARGETARCH" in \
      amd64) t=x86_64-unknown-linux-musl ;; \
      arm64) t=aarch64-unknown-linux-musl ;; \
      *) echo "no Rust target for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && echo "$t" > /target && rustup target add "$t" \
 && curl -sSfL "https://ziglang.org/download/$ZIG/zig-$(uname -m)-linux-$ZIG.tar.xz" | tar -xJ -C /opt \
 && ln -s /opt/zig-*/zig /usr/local/bin/zig \
 && cargo install --locked cargo-zigbuild@0.23.4
WORKDIR /src
COPY web/server/cloudflare-ips.txt web/server/
COPY web/server-rs web/server-rs
# no line tables in the image's binary (a third of its size); a panic still names its functions
ENV CARGO_PROFILE_RELEASE_DEBUG=0
# (the build folder goes once the binary is out: the layer, which the CI's cache keeps, holds 6 MB instead of 500)
RUN cd web/server-rs && cargo zigbuild --release --locked -p nfsu2-server --target "$(cat /target)" \
 && cp "target/$(cat /target)/release/nfsu2-server" /nfsu2-server && rm -rf target

FROM alpine:3.22
LABEL org.opencontainers.image.title="nfsu2-web-rs" \
      org.opencontainers.image.description="NFS Underground 2 in the browser: the server, in Rust (bring your own game)" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --from=page /src/web/dist web/dist
COPY --from=server /nfsu2-server /app/nfsu2-server
COPY --from=page --chown=1000:1000 --chmod=700 /state /state
# NFSU2_REPO: where the server finds the page (web/dist), as the Node image's server finds it next to itself
ENV NFSU2_REPO=/app \
    NFSU2_DATA=/game \
    NFSU2_WASM=/module/nfsu2.wasm \
    NFSU2_STATE=/state \
    NFSU2_MAX_PEERS=2000
# (a uid without a name: this stage runs nothing, so building it for arm64 needs no emulation)
USER 1000:1000
VOLUME /state
# the module is there and the server answers (over the HTTP port, which stays on 127.0.0.1)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${NFSU2_HTTP_PORT:-8080}/game.json" || exit 1
ENTRYPOINT ["/app/nfsu2-server"]
CMD ["--behind-proxy"]
