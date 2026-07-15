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

exec node packages/gateway/dist/main.js
