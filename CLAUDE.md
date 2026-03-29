# Claude Code Notes

Project-specific notes for Claude Code sessions.

## Project Documentation

- [PLAN.md](./PLAN.md) - Implementation roadmap and phase tracking
- [TODO](./TODO) - Bugs, feature requests, and items pending test
- [README.md](./README.md) - Project overview and setup
- [README_build.md](./README_build.md) - Build instructions
- [README_quirks.md](./README_quirks.md) - Known quirks and workarounds

**Keep these files updated with any code changes.** When implementing features or fixing bugs, update the relevant documentation (mark phases complete in PLAN.md, add/remove items in TODO, document new quirks, etc.).

## Environments

### Development (Pi)
- **Location**: `/home/pi/nft_entry_bot/` on `pi@four`
- **Bot**: Dev bot (existing test bot)
- **Screen session**: `nftbouncer`
- **Restart**: `screen -S nftbouncer -X stuff $'\003'`
- **Logs**: `tail -f bot.log`

### Production (nil)
- **Location**: `/home/pi/nft_entry_bot/` on `pi@nil`
- **Bot**: Steve (`@steve_bouncer_bot`)
- **Screen session**: `nftbouncer`
- **SSH**: `ssh nil` (key-based auth configured)

**Convenience scripts on nil** (in `~/bin`):
- `steve_logs` - tail production logs
- `steve_deploy` - git pull, build, restart
- `steve_restart` - just restart

**From Pi** (use `bash ~/bin/...` since non-interactive SSH doesn't load PATH):
```bash
ssh nil 'bash ~/bin/steve_logs'      # View logs
ssh nil 'bash ~/bin/steve_deploy'    # Deploy changes
ssh nil 'bash ~/bin/steve_restart'   # Restart only
```

## Deployment Workflow

1. Develop and test on Pi with dev bot
2. Commit and push: `git add . && git commit && git push`
3. Deploy to production: `ssh nil 'bash ~/bin/steve_deploy'`
4. Verify: `ssh nil 'bash ~/bin/steve_logs'`

**IMPORTANT: Do NOT deploy to production without explicit user consent.** Always ask before running `steve_deploy` or any command that affects the production bot.

## Viewing bot output (for testing)

run_nftbouncer.sh logs to `bot.log`, which can be `tail`ed to see output.

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
