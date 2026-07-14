# Build context must be the repo root — this is one workspace in the root
# package.json/package-lock.json (npm workspaces), and packages/web's package.json
# must be present too or `npm ci` fails (it can't resolve the lockfile's other
# declared workspace otherwise). On Railway: Root Directory = "." (repo root),
# Dockerfile Path = "packages/gateway/Dockerfile".
#
# Runs with ONCHAINOS_MODE=fake in production for now: the real `onchainos` CLI
# needs an interactively-created wallet session (~/.onchainos, holds encrypted key
# material) that can't be baked into an image. Going ONCHAINOS_MODE=live in a
# container is a separate piece of work for once the wallet is funded.

FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci

COPY packages/gateway packages/gateway
RUN npm run build --workspace packages/gateway

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/packages/gateway/package.json packages/gateway/package.json
COPY --from=builder /app/packages/gateway/dist packages/gateway/dist
# config.ts resolves the ONCHAINOS_MODE=fake binary path relative to the compiled
# file's own location (packages/gateway/test/fakes/onchainos) — needed at runtime,
# not just in CI, as long as we're deployed in fake mode.
COPY --from=builder /app/packages/gateway/test/fakes packages/gateway/test/fakes

CMD ["node", "packages/gateway/dist/main.js"]
