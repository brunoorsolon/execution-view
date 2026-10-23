# syntax=docker/dockerfile:1

# ---- build stage: compile the server (tsc) and the web UI (vite) ----
# Runs on the build machine's platform: its output is plain JavaScript, so a
# multi-arch build only emulates the small runtime stage.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build

# ---- runtime stage: production dependencies and compiled output only ----
FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.title="Forge Desk" \
      org.opencontainers.image.description="Deterministic dependency graph and execution order for open GitHub/Gitea issues" \
      org.opencontainers.image.source="https://github.com/brunoorsolon/forge-desk" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
WORKDIR /app

# Release execution needs real Git, SSH and Linux flock(2) in the final image, not only in the
# build stage: git fetches the candidate, ssh pushes the approved tag, and flock backs the
# single state-directory owner. BusyBox git/ssh are not sufficient.
RUN apk add --no-cache git openssh-client util-linux

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Demo config and its fixture. The fixture path in config.demo.yaml is relative
# to the config file, so the same layout is kept under /app.
COPY config.demo.yaml config.example.yaml ./
COPY test/fixtures/demo.json ./test/fixtures/demo.json

# FD_CONFIG is deliberately NOT set: an explicit path must exist, which would
# break env-only mode (FD_PROVIDER + FD_REPOS) when no file is mounted. Without
# it the default lookup is <cwd>/config.yaml, i.e. /app/config.yaml: mount your
# config there, or set FD_PROVIDER/FD_REPOS and mount nothing.
ENV FD_HOST=0.0.0.0 \
    FD_PORT=8080

# Pre-create the release state directory with the runtime user's ownership and mode, so a named
# volume mounted here inherits them on first use. A bind mount must be prepared on the host
# (docs/RELEASES.md), and planning-only deployments ignore this directory.
RUN install -d -m 0700 -o node -g node /var/lib/forge-desk

USER node
EXPOSE 8080

# A legacy EV_PORT still wins over FD_PORT, as in the config loader, until the next major release.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.EV_PORT||process.env.FD_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve"]
