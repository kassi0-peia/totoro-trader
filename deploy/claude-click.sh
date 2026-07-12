#!/bin/bash -l
# Desktop-icon entry: a terminal already running Claude Code in the workshop.
# Login shell (-l) so PATH matches her terminal (node, ~/.local/bin, etc.).
# `--continue` (the icon's right-click action) resumes the last session.
cd /home/tara/totoro-trader
exec /home/tara/.local/bin/claude "$@"
