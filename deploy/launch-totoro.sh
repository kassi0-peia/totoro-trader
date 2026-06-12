#!/bin/bash
# Launch the TotoroTrader PWA and force the window fullscreen.
# (--start-fullscreen is ignored for Chromium app windows, so we let the
# window manager do it: wait for the crx_ window, then add the fullscreen state.)
APP_ID="jmbmjadpgopdmpicnoaplijpoieffkpo"
/opt/brave.com/brave/brave-browser --profile-directory=Default --app-id="$APP_ID" &
for _ in $(seq 1 60); do
  sleep 0.25
  WIN=$(wmctrl -lx 2>/dev/null | awk -v c="crx_$APP_ID" '$3 ~ c {print $1; exit}')
  if [ -n "$WIN" ]; then
    wmctrl -i -r "$WIN" -b add,fullscreen
    exit 0
  fi
done
