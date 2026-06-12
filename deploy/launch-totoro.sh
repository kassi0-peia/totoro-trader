#!/bin/bash
# Launch the TotoroTrader PWA and put it into BRAVE'S OWN fullscreen (F11).
# WM-forced fullscreen (wmctrl) only resizes the window — Brave keeps drawing
# its app title bar unless it enters fullscreen itself, so we press F11 on the
# freshly mapped window via xdotool.
APP_ID="jmbmjadpgopdmpicnoaplijpoieffkpo"
list_wins() { wmctrl -lx 2>/dev/null | awk -v c="crx_$APP_ID" '$3 ~ c {print $1}'; }
BEFORE=$(list_wins)
/opt/brave.com/brave/brave-browser --profile-directory=Default --app-id="$APP_ID" &
for _ in $(seq 1 80); do
  sleep 0.25
  for w in $(list_wins); do
    case " $BEFORE " in *" $w "*) continue;; esac   # only the NEW window
    sleep 0.4                                       # let it finish mapping
    wmctrl -i -a "$w"                               # focus it
    sleep 0.2
    xdotool key --clearmodifiers F11                # Brave's real fullscreen
    exit 0
  done
done
# No new window appeared (Brave focused an existing one instead): fullscreen that.
W=$(list_wins | head -1)
if [ -n "$W" ] && ! xprop -id "$W" _NET_WM_STATE 2>/dev/null | grep -q FULLSCREEN; then
  wmctrl -i -a "$W"; sleep 0.2; xdotool key --clearmodifiers F11
elif [ -n "$W" ]; then wmctrl -i -a "$W"; fi
