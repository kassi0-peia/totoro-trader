#!/bin/bash
# Desktop-icon entry point: the full `totoro` start (Gateway auto-login +
# bridge + app window) with output kept in /tmp/totoro-start.log — .desktop
# Exec lines can't carry shell redirections themselves.
exec /home/tara/totoro-trader/start-all.sh "${1:-paper}" >>/tmp/totoro-start.log 2>&1
