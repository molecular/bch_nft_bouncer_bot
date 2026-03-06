# Claude Code Notes

Project-specific notes for Claude Code sessions.

## Project Documentation

- [PLAN.md](./PLAN.md) - Implementation roadmap and phase tracking
- [TODO](./TODO) - Bugs, feature requests, and items pending test
- [README.md](./README.md) - Project overview and setup
- [README_build.md](./README_build.md) - Build instructions
- [README_quirks.md](./README_quirks.md) - Known quirks and workarounds

**Keep these files updated with any code changes.** When implementing features or fixing bugs, update the relevant documentation (mark phases complete in PLAN.md, add/remove items in TODO, document new quirks, etc.).

## Restarting the Bot

The bot runs in a screen session named `nftbouncer` that runs `run.sh`.

To restart:
```bash
screen -S nftbouncer -X stuff $'\003'
```

This sends Ctrl-C to the screen session, which stops the current process. The screen session has a loop or script that restarts `npm run dev` automatically.

## Viewing bot output (for testing)

run.sh logs to `bot.log`, which can be `tail`ed to see output.

## Testing Methodology

No automated tests. Telegram bots are difficult to test automatically (can't create test accounts freely, real interactions require manual effort).

**Approach:**
- Manual testing only, using personal Telegram account + community volunteers
- Plan testing phases carefully before deploying changes
- Group related changes together to minimize test cycles
- Track items pending test in [TODO](./TODO)

When implementing features, consider what needs to be tested together and batch changes accordingly.
