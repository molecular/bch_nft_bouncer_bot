#!/bin/bash
cd "$(dirname "$0")"
while true; do
  npx tsx watch src/index.ts 2>&1 | tee bot.log
  echo "Bot exited, restarting in 3s..."
  sleep 3
done
