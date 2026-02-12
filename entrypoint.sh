#!/bin/sh
set -e

if [ "$BOT_MODE" = "processor" ]; then
  echo "Starting in Processor mode..."
  exec node processor.js
else
  echo "Starting in Listener mode..."
  exec node listener.js
fi