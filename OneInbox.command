#!/bin/bash
# Double-click to open OneInbox on a Mac.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1 || ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "OneInbox needs Node.js 22.13 or newer."
  echo "Install the LTS version from https://nodejs.org and then double-click this file again."
  read -r -p "Press Return to close."
  exit 1
fi

if [ ! -d node_modules/electron ]; then
  echo "First run: setting up the desktop window (one time, about a minute)..."
  npm install --no-audit --no-fund
fi

if [ -d node_modules/electron ]; then
  npm run desktop
else
  echo "The desktop window could not be set up, so OneInbox is opening in your browser instead."
  (sleep 2 && open "http://localhost:4747") &
  npm start
fi
