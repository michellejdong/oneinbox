#!/bin/bash
# Double-click to fetch the newest version from GitHub. Your messages and settings (the "data" folder) are not touched.
cd "$(dirname "$0")" || exit 1
git checkout main && git pull --ff-only && npm install --no-audit --no-fund \
  && echo "Up to date. Quit and reopen OneInbox to use the new version." \
  || echo "The update did not finish. Nothing in your data was changed."
read -r -p "Press Return to close."
