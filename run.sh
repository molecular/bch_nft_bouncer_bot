#!/bin/bash
cd "$(dirname "$0")"

BOT_PID=""

# On SIGINT (Ctrl+C), kill only the bot process, not the whole script
restart_bot() {
  if [ -n "$BOT_PID" ]; then
    kill $BOT_PID 2>/dev/null
  fi
}
trap restart_bot SIGINT

while true; do
  # Use process substitution to keep tsx as the main process we track
  npx tsx watch src/index.ts > >(tee bot.log) 2>&1 &
  BOT_PID=$!
  wait $BOT_PID
  echo "Bot exited, restarting in 3s..."
  sleep 3
done
