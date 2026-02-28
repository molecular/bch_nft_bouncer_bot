# Claude Code Notes

Project-specific notes for Claude Code sessions.

## Project Plan

See [PLAN.md](./PLAN.md) for the implementation roadmap and phase tracking.
See [TODO](./TODO) for bugs, feature requests, and items pending test.

## Restarting the Bot

The bot runs in a screen session named `nftbouncer` that runs `run.sh`.

To restart:
```bash
screen -S nftbouncer -X stuff $'\003'
```

This sends Ctrl-C to the screen session, which stops the current process. The screen session has a loop or script that restarts `npm run dev` automatically.

## Viewing bot output (for testing)

run.sh logs to `bot.log`, which can be `tail`ed to see output.
