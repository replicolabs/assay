# Build context must be the repo root — this is one workspace in the root
# package.json/package-lock.json (npm workspaces), and packages/web's package.json
# must be present too or `npm ci` fails (it can't resolve the lockfile's other
# declared workspace otherwise). On Railway: Root Directory = "." (repo root),
# Dockerfile Path = "packages/gateway/Dockerfile".
#
# ONCHAINOS_MODE=live: the real `onchainos` CLI is baked into the runtime image
# below and logs in non-interactively at container boot (docker-entrypoint.sh),
# via AK login (OKX_API_KEY/SECRET/PASSPHRASE env vars) — confirmed this
# re-authenticates to the same OKX-managed account/wallet on any machine, not a
# machine-local keypair, so no key material needs to be copied into the image.
#
# A2A_RESPONDER_ENABLED=true additionally needs the `okx-a2a` daemon
# (@okxweb3/a2a-node) — used by `onchainos agent contact-user` to actually
# send the A2A negotiation opener — which itself requires an authenticated AI
# provider CLI bound to it. Live-verified: Claude Code CLI (@anthropic-ai/claude-code)
# authenticates fully headlessly from a bare ANTHROPIC_API_KEY env var (no
# OAuth/interactive login needed), and `okx-a2a doctor --fix --non-interactive`
# bootstraps the whole chain (provider binding, daemon start) unattended from a
# completely fresh $HOME — confirmed by reproducing a clean container-like
# environment locally before adding this, not assumed.

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

# ca-certificates: TLS to Neon and to OKX's backend. curl: fetches the onchainos
# installer (build-time only, but curl itself stays in the image; harmless).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh \
    && mv /root/.local/bin/onchainos /usr/local/bin/onchainos \
    && rm -rf /var/lib/apt/lists/*

# A2A negotiation-responder dependencies (see note above) — only exercised when
# A2A_RESPONDER_ENABLED=true, but installed unconditionally since it's a build-time
# step either way and keeps the entrypoint free of package-manager logic.
RUN npm install -g @anthropic-ai/claude-code @okxweb3/a2a-node

COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/packages/gateway/package.json packages/gateway/package.json
COPY --from=builder /app/packages/gateway/dist packages/gateway/dist
# config.ts resolves the ONCHAINOS_MODE=fake binary path relative to the compiled
# file's own location (packages/gateway/test/fakes/onchainos) — needed at runtime
# whenever ONCHAINOS_MODE=fake (e.g. testing this same image locally).
COPY --from=builder /app/packages/gateway/test/fakes packages/gateway/test/fakes

COPY packages/gateway/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

CMD ["/app/docker-entrypoint.sh"]
