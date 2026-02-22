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
2. **Grant permissions**: The bot needs "Ban users" and "Restrict members" permissions
3. **Run `/setup`** in your group to initialize
4. **Add NFT categories** with `/add_category <category_id>`
   - The category ID is the 64-character hex transaction ID of the NFT genesis
   - Example: `/add_category 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`

### Admin Commands

| Command | Description |
|---------|-------------|
| `/setup` | Initialize the bot for your group |
| `/add_category <id>` | Add an NFT category for access |
| `/remove_category <id>` | Remove an NFT category |
| `/list_categories` | List configured NFT categories |
| `/status` | Show group configuration and bot permissions |
| `/scan` | Re-check all verified members (kicks those who no longer hold NFTs) |
| `/adminhelp` | Show admin command help |

### How It Works

1. New members who message the group are prompted to verify
2. Users click the verification link to start a DM with the bot
3. Users connect their BCH wallet via WalletConnect (or manual signature)
4. Bot verifies NFT ownership and grants access
5. Background monitoring detects when NFTs are transferred and removes access

---

## For Users

### Verifying Your NFT

1. **Join the group** - You'll receive a verification prompt
2. **Click the verification link** to start a DM with the bot
3. **Choose verification method**:
   - **WalletConnect** (recommended): Send `/wc`, scan the QR code with your BCH wallet (Cashonize, Paytaca, Zapit, etc.)
   - **Manual**: Send your BCH address, sign the challenge message in your wallet, paste the signature
4. **Done!** You'll have full access to the group

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

## Links

- [GitHub Repository](https://github.com/molecular/bch_nft_bouncer_bot)
- [Bitcoin Cash](https://bitcoincash.org)
- [CashTokens](https://cashtokens.org)
