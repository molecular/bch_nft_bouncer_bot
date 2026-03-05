#!/bin/bash
cd "$(dirname "$0")"

LOG_DIR="logs"
mkdir -p "$LOG_DIR"

BOT_PID=""
CURRENT_LOG=""

# Get log filename for current date
get_log_file() {
  echo "$LOG_DIR/bot-$(date +%Y-%m-%d).log"
}

# Update symlink to point to current log
update_symlink() {
  local log_file="$1"
  rm -f bot.log
  ln -s "$log_file" bot.log
}

# On SIGINT (Ctrl+C), kill only the bot process, not the whole script
restart_bot() {
  if [ -n "$BOT_PID" ]; then
    kill $BOT_PID 2>/dev/null
  fi
}
trap restart_bot SIGINT

while true; do
  # Check if we need a new log file (date changed)
  NEW_LOG=$(get_log_file)
  if [ "$NEW_LOG" != "$CURRENT_LOG" ]; then
    CURRENT_LOG="$NEW_LOG"
    update_symlink "$CURRENT_LOG"
  fi

  echo -e "\n\n========== Bot starting at $(date) ==========\n" >> "$CURRENT_LOG"
  # Use process substitution to keep tsx as the main process we track
  npx tsx src/index.ts 2>&1 | tee -a "$CURRENT_LOG" &
  BOT_PID=$!
  wait $BOT_PID
  echo "Bot exited, restarting in 1s..."
  sleep 1
done
