#!/usr/bin/env bash
# Launch the TotoroTrader bridge (HTTPS + live data) DETACHED so it survives the
# interactive terminal session. Idempotent: does nothing if :8787 is already serving.
if ss -tlnp 2>/dev/null | grep -q ':8787'; then
  echo "bridge already running on :8787"
  exit 0
fi
TLS=1 IBKR_MD_TYPE=1 setsid /usr/bin/node /home/youruser/totoro-trader/server/ibkr-server.js \
  < /dev/null >> /tmp/totoro-bridge.log 2>&1 &
echo "bridge started detached; logging to /tmp/totoro-bridge.log"
