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

## Refactoring Guidelines

When refactoring code, be careful not to remove functionality you don't fully understand:

- **Preserve function calls when rewriting lines.** If changing `**bold**` to `*bold*`, don't rewrite the whole line - just change what needs changing. A line like `\`${escapeMarkdown(name)}\`` should keep the `escapeMarkdown()` call even if you're modifying surrounding syntax.

- **Understand why utilities exist before removing them.** If a utility function escapes characters for Markdown, it's protecting against user input (group names, usernames) breaking the message - not related to the message's own formatting syntax.

- **User input vs message syntax are separate concerns.** `escapeMarkdown(groupName)` handles characters in `groupName` (user data). The `*bold*` syntax around it is message formatting. Changing one doesn't affect the need for the other.
