# Claude Code Notes

Project-specific notes for Claude Code sessions.

## Restarting the Bot

The bot runs in a screen session named `nftbouncer` with `tsx watch`.

To restart:
```bash
screen -S nftbouncer -X stuff $'\003'
```

This sends Ctrl-C to the screen session, which stops the current process. The screen session has a loop or script that restarts `npm run dev` automatically.
