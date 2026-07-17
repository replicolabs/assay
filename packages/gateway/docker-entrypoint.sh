#!/bin/sh
set -e

# ONCHAINOS_MODE=live needs an authenticated wallet session before any request
# can succeed. AK login (no email arg) is non-interactive — it reads
# OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE straight from the environment
# and re-authenticates to the same OKX-managed account every boot (confirmed:
# this is a backend account tied to the API key, not a machine-local keypair,
# so a fresh container reaches the exact same wallet/agent identities every
# time). Fails loudly (set -e) rather than starting a server that would fail
# every live request with "session expired."
if [ "$ONCHAINOS_MODE" = "live" ]; then
  onchainos wallet login --force
fi

# A2A_RESPONDER_ENABLED=true needs the okx-a2a daemon bootstrapped (provider
# binding + background daemon start) before any `agent contact-user` call can
# succeed — live-verified via `okx-a2a doctor --fix --non-interactive`, which
# does this unattended from a bare ANTHROPIC_API_KEY, no OAuth login needed.
# Deliberately NOT `set -e` here: this is one feature, not the whole service —
# if it fails, the REST API should still boot; a2aResponder.ts logs its own
# per-tick failures rather than needing the whole container to go down over it.
if [ "$ONCHAINOS_MODE" = "live" ] && [ "$A2A_RESPONDER_ENABLED" = "true" ]; then
  okx-a2a doctor --fix --non-interactive --json || echo "[entrypoint] okx-a2a bootstrap failed — A2A responder will error until this is fixed, but the rest of the service will still start"
fi

exec node packages/gateway/dist/main.js
