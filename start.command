#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PBIP Lineage Explorer - one-click launcher (macOS / Linux)
#
# macOS: double-click this file in Finder. If it opens in a text editor
# instead, run once:  chmod +x start.command
#
# Linux: ./start.command  (or mark it executable in your file manager)
#
# Nothing is uploaded anywhere - the server is local to this machine and your
# PBIP files are read entirely inside the browser.
# ---------------------------------------------------------------------------

set -u
cd "$(dirname "$0")" || exit 1

echo "============================================"
echo "  PBIP Lineage Explorer"
echo "============================================"
echo

# --- 1. Node.js present? ----------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js was not found on this machine."
  echo
  echo "    PBIP Lineage Explorer needs Node.js to serve the page locally."
  echo "    Install the LTS version from https://nodejs.org"
  echo "    (or via Homebrew:  brew install node)"
  echo
  echo "    Then run this file again."
  echo
  read -r -p "Press Return to close..." _
  exit 1
fi

echo "Node.js $(node --version) detected."
echo

# --- 2. Dependencies installed? --------------------------------------------
if [ ! -f "node_modules/vite/package.json" ]; then
  echo "First run - installing dependencies. This takes a few minutes."
  echo "(Only happens once.)"
  echo
  if ! npm install; then
    echo
    echo "[!] 'npm install' did not finish successfully."
    echo "    Check your internet connection or npm proxy settings, then retry."
    echo
    read -r -p "Press Return to close..." _
    exit 1
  fi
  echo
  echo "Dependencies installed."
  echo
fi

# --- 3. Launch ---------------------------------------------------------------
URL="http://localhost:5173"

echo "Starting the local server..."
echo
echo "  Your browser should open automatically."
echo "  If it does not, open:  $URL"
echo
echo "  Use Chrome or Edge - Firefox and Safari cannot open folders."
echo
echo "  Leave this window open while using the tool."
echo "  Press Ctrl+C to stop."
echo

# Open the browser once the port is actually listening (max ~20s).
(
  for _ in $(seq 1 40); do
    if command -v curl >/dev/null 2>&1; then
      curl -s -o /dev/null "$URL" && break
    else
      sleep 0.5
    fi
    sleep 0.5
  done
  if command -v open >/dev/null 2>&1; then
    open "$URL"                 # macOS
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1   # Linux
  fi
) &

npm run dev

echo
echo "Server stopped."
