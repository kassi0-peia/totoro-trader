#!/bin/bash
# launch-totoro.sh — open TotoroTrader in a dedicated, fullscreen Firefox window.
#
# The app is served by the always-on `totoro-bridge` systemd service over HTTPS on
# :8787 (mkcert cert). This script ONLY opens the window — `start-all.sh` (the
# `totoro` command) brings IB Gateway + the bridge up first. The desktop shortcut
# points straight here (services assumed already up).
#
# Why a dedicated profile: it gives us our own chromeless window that won't hijack
# a normal Firefox you have open, and we trust the mkcert root CA inside it so the
# self-signed cert shows green with no warning.
set -euo pipefail

URL="${TOTORO_URL:-https://localhost:8787}"
PROFILE_DIR="$HOME/.config/firefox-totoro"
ROOTCA="$HOME/.local/share/mkcert/rootCA.pem"
ICON="$HOME/totoro-trader/public/icon-512.png"          # Opus 4.7's totoro art
ICON_HELPER="$HOME/totoro-trader/deploy/set-window-icon.py"

# First run: build the profile — trust mkcert's root CA, quiet the first-run noise.
if [ ! -f "$PROFILE_DIR/cert9.db" ]; then
  mkdir -p "$PROFILE_DIR"
  if [ -f "$ROOTCA" ] && command -v certutil >/dev/null 2>&1; then
    certutil -A -n "mkcert-totoro" -t "C,," -i "$ROOTCA" -d "sql:$PROFILE_DIR" || true
  fi
  cat > "$PROFILE_DIR/user.js" <<'PREFS'
// Trust certs from the OS store too (mkcert installs its root there) — belt and
// suspenders alongside the certutil import above.
user_pref("security.enterprise_roots.enabled", true);
// App-window hygiene: no default-browser nag, no close warning, no onboarding.
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
// Enable userChrome.css below → chromeless app window (no tabs / address bar).
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
// CSD: Firefox draws its own title bar (which userChrome then hides) so the WM
// draws NO title bar — gone from the first frame. Muffin ignores _MOTIF hints, so
// this is the reliable way to lose the top bar on Cinnamon.
user_pref("browser.tabs.inTitlebar", 1);
// Dark everything — no white flash on launch, chrome matches the app.
user_pref("ui.systemUsesDarkTheme", 1);
user_pref("browser.theme.toolbar-theme", 0);
user_pref("browser.theme.content-theme", 0);
user_pref("browser.display.background_color", "#0a0c12");
PREFS
  # Chromeless: hide the tab strip + nav/address bar so it's the app, not a browser.
  mkdir -p "$PROFILE_DIR/chrome"
  printf '%s\n' '#navigator-toolbox { visibility: collapse !important; }' > "$PROFILE_DIR/chrome/userChrome.css"
fi

# ALREADY OPEN? Just focus it. With MOZ_NO_REMOTE a second launch can't re-open the
# same profile, so it would silently do nothing ("doesn't open in tt window"). If a
# Firefox is already running on THIS profile, raise its window and stop.
if pgrep -f -- "firefox --profile $PROFILE_DIR" >/dev/null 2>&1; then
  WID=$(wmctrl -l 2>/dev/null | grep -i "TotoroTrader" | awk '{print $1; exit}')
  [ -n "$WID" ] && wmctrl -i -a "$WID"
  exit 0
fi

# Not running → fresh launch. Clear any stale lock from a previous crash/kill first
# (a leftover lock makes Firefox do its "remote" handoff instead of opening its own
# window). Safe to remove now that no Firefox owns this profile.
rm -f "$PROFILE_DIR/lock" "$PROFILE_DIR/.parentlock" 2>/dev/null || true

# Launch our OWN instance — never --kiosk (that locked fullscreen + grabbed the
# keyboard, trapping us on a black page → hard restarts). MOZ_NO_REMOTE=1 = a fully
# independent instance that won't merge into another Firefox; with the dedicated
# profile that guarantees its own window. Backgrounded (setsid) so it survives this
# script exiting and so we can strip the WM title bar once the window maps.
# --class=totorotrader: Firefox sets the WM_CLASS *class* to this (the instance stays
# "Navigator" — Firefox hardcodes that, and --name can't change it). A .desktop with
# StartupWMClass=totorotrader matches on exactly this unique class → Cinnamon shows the
# totoro icon for THIS window only, never your everyday Firefox (class "firefox").
setsid env MOZ_NO_REMOTE=1 firefox --class=totorotrader --profile "$PROFILE_DIR" --new-window "$URL" &

# The WM title bar is removed via Firefox CSD (browser.tabs.inTitlebar=1 in user.js)
# + userChrome hiding the toolbox — so it's gone from the first frame, no Motif/WM
# trick needed (Muffin ignores _MOTIF_WM_HINTS anyway). Here we just maximize to fill
# the screen and stamp the window with the totoro icon. Wait for the window first.
for _ in $(seq 1 60); do
  WID=$(wmctrl -l 2>/dev/null | grep -i "TotoroTrader" | awk '{print $1; exit}')
  if [ -n "$WID" ]; then
    wmctrl -i -r "$WID" -b add,maximized_vert,maximized_horz
    # Per-window icon only (no WM-class meddling — that interfered with normal Firefox).
    [ -f "$ICON" ] && python3 "$ICON_HELPER" "$WID" "$ICON" 2>/dev/null || true
    # Launch straight into Firefox's OWN fullscreen (covers the panel too). Unlike
    # --kiosk this is escapable: press F11 to toggle back out anytime.
    wmctrl -i -a "$WID"; sleep 0.4
    xdotool key --clearmodifiers F11
    break
  fi
  sleep 0.5
done
