#!/bin/sh
set -e

if [ "$BOT_MODE" = "processor" ]; then
  echo "Starting in Processor mode..."
  exec node processor.js
else
  # Clean up stale Chrome lock files from previous crashes.
  # These persist on the mounted volume and prevent Chrome from launching.
  SESSION_DIR="${PUPPETEER_SESSION_DIR:-/usr/src/app/puppeteer_session}"
  if [ -d "$SESSION_DIR" ]; then
    find "$SESSION_DIR" -name 'SingletonLock' -delete 2>/dev/null || true
    find "$SESSION_DIR" -name 'SingletonSocket' -delete 2>/dev/null || true
    find "$SESSION_DIR" -name 'SingletonCookie' -delete 2>/dev/null || true
  fi

  echo "Starting in Listener mode..."
  exec node listener.js
fi