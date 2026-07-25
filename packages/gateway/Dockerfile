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
# binary (build-time only, but curl itself stays in the image; harmless).
#
# PINNED to v4.2.6 — deliberately NOT the installer's "latest" pointer.
# Live-verified 2026-07-23: a fresh `curl install.sh | sh` build pulls v4.3.0,
# which replaced non-interactive AK (API-key) wallet login with a browser-only
# OAuth flow (`wallet login --phase init|open|poll`, opens a real browser page
# for the human to complete). There is no headless path left in v4.3.0 — the
# old `--force` flag is gone entirely, not renamed. A container built against
# it crash-loops forever on `onchainos wallet login --force` in
# docker-entrypoint.sh (`set -e` kills the entrypoint before `node main.js`
# ever runs), taking the whole gateway down. v4.2.6 is the last version with
# working headless AK login. Checksum-verified the same way the official
# installer does (same GitHub release assets, just pinned instead of
# "latest"). Revisit this pin if/when OKX ships a headless auth path for
# v4.3+ — check for it before assuming still needed.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -sSL "https://github.com/okx/onchainos-skills/releases/download/v4.2.6/onchainos-x86_64-unknown-linux-gnu" -o /tmp/onchainos \
    && curl -sSL "https://github.com/okx/onchainos-skills/releases/download/v4.2.6/checksums.txt" -o /tmp/checksums.txt \
    && echo "$(grep 'onchainos-x86_64-unknown-linux-gnu' /tmp/checksums.txt | awk '{print $1}')  /tmp/onchainos" | sha256sum -c - \
    && chmod +x /tmp/onchainos \
    && mv /tmp/onchainos /usr/local/bin/onchainos \
    && rm -f /tmp/checksums.txt \
    && rm -rf /var/lib/apt/lists/*

# A2A negotiation-responder dependencies (see note above) — only exercised when
# A2A_RESPONDER_ENABLED=true, but installed unconditionally since it's a build-time
# step either way and keeps the entrypoint free of package-manager logic.
RUN npm install -g @anthropic-ai/claude-code @okxweb3/a2a-node

# Claude Code CLI hard-refuses to run with --dangerously-skip-permissions as
# root/sudo (a fixed safety check, not configurable) — and the okx-a2a
# daemon's autonomous background negotiation needs exactly that flag for
# headless operation. This container ran as root (the node:22-slim default)
# with no non-root user ever created, which meant EVERY autonomous dispatch
# silently failed from the moment the daemon was added — live-verified
# 2026-07-24 via a temporary diagnostic route reading the daemon's own
# pending-decision queue: every entry was `missing_session_id`, stderr
# "--dangerously-skip-permissions cannot be used with root/sudo privileges
# for security reasons". Our own one-off `contactUser` opener calls still
# worked (those go through the plain onchainos CLI, not Claude), which is why
# this stayed hidden — only the Claude-driven continuation of a negotiation
# was broken. Fix: run as a real non-root user.
RUN useradd --create-home --shell /bin/bash appuser

# The `okx-ai` skill (task marketplace / ASP negotiation protocol — apply /
# deliver / next-action / event handling) that autonomous Claude sessions
# need to actually complete a negotiation correctly, not just guess CLI
# syntax. On an interactive dev machine this gets installed automatically
# into ~/.claude/skills/ by tooling outside this container's reach; a fresh
# headless container has no such install step, so Claude found nothing there
# — live-verified 2026-07-24 (a real dispatch failure showed Claude running
# `find / -path "*okx-ai*"` and coming up empty, then guessing a wrong CLI
# flag). Vendored from OKX's own Apache-2.0-licensed skill content
# (packages/gateway/vendor/okx-skills/okx-ai) rather than depending on an
# undiscovered install mechanism. Placed under ~/.agents/skills with a
# ~/.claude/skills symlink, mirroring the exact layout seen on a working dev
# machine, since Claude Code's skill discovery reads from ~/.claude/skills.
COPY --chown=appuser:appuser packages/gateway/vendor/okx-skills/okx-ai /home/appuser/.agents/skills/okx-ai
RUN mkdir -p /home/appuser/.claude/skills \
    && ln -s ../../.agents/skills/okx-ai /home/appuser/.claude/skills/okx-ai

# Live-verified 2026-07-25 (via the temporary diagnostic route's log read):
# the daemon's autonomous dispatch was defaulting to claude-opus-5[1m] for
# every session — $0.32 for a single mechanical "check status, notify if
# failed, don't retry" job. With ~5 stuck jobs re-dispatched on every
# container restart while iterating on this feature today, that model choice
# alone is the dominant cost driver, not session-failure churn. This task
# needs a status check and a templated notification, not opus-level
# reasoning — pin the default model to something dramatically cheaper via
# Claude Code's own settings.json (standard mechanism, reads from $HOME).
COPY --chown=appuser:appuser packages/gateway/vendor/claude-config/settings.json /home/appuser/.claude/settings.json

# Assay's own negotiation policy (pricing floor, scope-expansion handling,
# last-minute-change handling) — real judgment calls the okx-ai protocol
# skill deliberately doesn't cover, since it's protocol-only, not business
# policy. CLAUDE.md is Claude Code's always-loaded context (unlike a skill,
# no trigger-matching needed), so this applies to every autonomous session
# under this user without depending on the daemon's prompt happening to
# mention it.
COPY --chown=appuser:appuser packages/gateway/vendor/claude-config/CLAUDE.md /home/appuser/.claude/CLAUDE.md

RUN chown -R appuser:appuser /home/appuser/.claude /home/appuser/.agents

COPY --from=builder --chown=appuser:appuser /app/node_modules node_modules
COPY --from=builder --chown=appuser:appuser /app/packages/gateway/package.json packages/gateway/package.json
COPY --from=builder --chown=appuser:appuser /app/packages/gateway/dist packages/gateway/dist
# config.ts resolves the ONCHAINOS_MODE=fake binary path relative to the compiled
# file's own location (packages/gateway/test/fakes/onchainos) — needed at runtime
# whenever ONCHAINOS_MODE=fake (e.g. testing this same image locally).
COPY --from=builder --chown=appuser:appuser /app/packages/gateway/test/fakes packages/gateway/test/fakes

COPY --chown=appuser:appuser packages/gateway/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

USER appuser

CMD ["/app/docker-entrypoint.sh"]
