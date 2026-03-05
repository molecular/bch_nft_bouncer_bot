# BCH NFT Bouncer Bot

A Telegram bot that gates group access based on Bitcoin Cash NFT (CashToken) ownership. Similar to captcha bots, but requires cryptographic proof of NFT ownership instead.

## Use the Public Bot

**You don't need to run your own instance!** Group owners can use the public bot:

**[@bch_nft_bouncer_bot](https://t.me/bch_nft_bouncer_bot)**

Just add it to your group and configure your NFT categories.

---

## For Group Owners

### Setup

1. **Add the bot** to your Telegram group as an administrator
2. **Grant permissions**: The bot needs these admin permissions:
   - **Restrict members** - to mute unverified users
   - **Ban users** - to kick users who no longer hold NFTs
   - **Add new admins** - to unrestrict verified users (uses promote/demote cycle)
3. **Run `/setup`** in your group to initialize
4. **Add NFT categories** with `/add_category <category_id>`
   - The category ID is the 64-character hex transaction ID of the NFT genesis
   - Example: `/add_category 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`

### Admin Commands

| Command | Description |
|---------|-------------|
| `/setup` | Initialize the bot for your group |
| `/add_condition nft <cat> [label] [start] [end]` | Add NFT requirement with optional commitment range |
| `/add_condition balance <cat\|BCH> <amount> [label]` | Add token or BCH balance requirement |
| `/list_conditions` | List all access conditions with IDs |
| `/remove_condition <id>` | Remove a condition by ID |
| `/status` | Show group configuration and bot permissions |
| `/scan` | Re-check all verified members |
| `/adminhelp` | Show admin command help |

**Legacy commands** (still work):
- `/add_category <id>` - Add NFT category (no commitment range)
- `/remove_category <id>` - Remove NFT category
- `/list_categories` - List NFT categories

### Access Rules

Access rules determine who can join your group:

- **NFT rules**: Require ownership of an NFT, optionally with a specific commitment range
- **Balance rules**: Require a minimum amount of a fungible token or BCH

**Logic:**
- NFT rules: OR logic - user must satisfy **at least one** NFT rule
- Balance rules: OR logic - user must satisfy **at least one** balance rule
- Between types: AND logic - if both types exist, user must satisfy at least one of each

**Examples:**
```
/add_condition nft abc123...                    # Any NFT from category
/add_condition nft abc123... Jessicas 01 64     # Commitments 01-64 named "Jessicas"
/add_condition balance BCH 21                   # Require 21 BCH
/add_condition balance def456... 1000 FURU      # Require 1000 FURU tokens
```

### How It Works

1. New members who message the group are prompted to verify
2. Users click the verification link to start a DM with the bot
3. Users connect their BCH wallet via WalletConnect (or manual signature)
4. Bot verifies wallet contents against access conditions and grants access
5. **Real-time monitoring** detects changes and updates access automatically:
   - NFT transfers, token balance changes, BCH balance changes
   - Users are notified of condition status changes via DM
   - Access is granted/revoked automatically as conditions are met/unmet

---

## For Users

### Verifying Your Wallet

1. **Join the group** - You'll receive a verification prompt
2. **Click the verification link** to start a DM with the bot
3. **Choose verification method**:
   - **WalletConnect** (recommended): Send `/wc`, scan the QR code with your BCH wallet
   - **Manual**: Send your BCH address, sign the challenge message, paste the signature
4. **Multi-address support**: If your assets are spread across multiple wallets, you can verify additional addresses to meet all requirements
5. **Done!** You'll have full access to the group

### User Commands

| Command | Description |
|---------|-------------|
| `/verify` | Start or continue verification |
| `/wc` | Connect wallet via WalletConnect QR code |
| `/sign` | Resend signature request (after rejection) |
| `/list_verifications` | Show your verified addresses |
| `/unverify <id>` | Remove a verified address |
| `/cancel` | Cancel current verification |

### Supported Wallets

Any BCH wallet that supports WalletConnect:
- Cashonize
- Paytaca
- Zapit
- Selene

For manual verification, any wallet that can sign messages (including Electron Cash).

---

## Self-Hosting

Want to run your own instance? See [README_build.md](README_build.md) for build and deployment instructions.

---

## Technical Notes

- [Telegram API Quirks & Workarounds](README_quirks.md) - undocumented API behaviors and solutions

---

## Links

- [GitHub Repository](https://github.com/molecular/bch_nft_bouncer_bot)
- [Bitcoin Cash](https://bitcoincash.org)
- [CashTokens](https://cashtokens.org)
