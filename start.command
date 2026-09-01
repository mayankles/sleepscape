#!/bin/bash
# Sleepscape launcher for macOS.
# Double-click this file in Finder to start the app (you may need to
# right-click > Open the first time, since it's an unsigned script).
#
# Why a local server instead of just opening index.html directly?
# YouTube's embedded player needs a real http:// page (not a file:// one)
# to talk back to the page correctly, so this spins up a tiny local
# web server and opens your browser to it.

cd "$(dirname "$0")"

PORT=8791

# Prefer python3, fall back to python if that's what's on PATH.
if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  echo "Couldn't find python3 on this Mac. Install it (e.g. 'brew install python') and try again."
  read -p "Press Enter to close..."
  exit 1
fi

echo "Starting Sleepscape at http://localhost:$PORT ..."
open "http://localhost:$PORT" &

"$PYTHON" -m http.server "$PORT"
