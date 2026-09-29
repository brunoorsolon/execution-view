# syntax=docker/dockerfile:1

# ---- build stage: compile the server (tsc) and the web UI (vite) ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build

# ---- runtime stage: production dependencies and compiled output only ----
FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.title="execution-view" \
      org.opencontainers.image.description="Deterministic dependency graph and execution order for open GitHub/Gitea issues" \
      org.opencontainers.image.source="https://github.com/brunoorsolon/execution-view" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Demo config and its fixture. The fixture path in config.demo.yaml is relative
# to the config file, so the same layout is kept under /app.
COPY config.demo.yaml config.example.yaml ./
COPY test/fixtures/demo.json ./test/fixtures/demo.json

# EV_CONFIG is deliberately NOT set: an explicit path must exist, which would
# break env-only mode (EV_PROVIDER + EV_REPOS) when no file is mounted. Without
# it the default lookup is <cwd>/config.yaml, i.e. /app/config.yaml: mount your
# config there, or set EV_PROVIDER/EV_REPOS and mount nothing.
ENV EV_HOST=0.0.0.0 \
    EV_PORT=8080

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.EV_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve"]
