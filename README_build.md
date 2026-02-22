# Building and Running BCH NFT Bouncer Bot

Instructions for self-hosting your own instance of the bot.

## Requirements

- Node.js 18.20.8+ (Node 20+ recommended)
- npm

## Setup

### 1. Clone the Repository

```bash
git clone https://github.com/molecular/bch_nft_bouncer_bot.git
cd bch_nft_bouncer_bot
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 4. Get a WalletConnect Project ID (Optional)

WalletConnect enables QR-code based wallet connection. Without it, users can still verify via manual signature.

1. Go to [cloud.reown.com](https://cloud.reown.com) (formerly WalletConnect Cloud)
2. Create an account and a new project
3. Copy the Project ID

### 5. Configure Environment

Create a `.env` file:

```bash
BOT_TOKEN=your_telegram_bot_token
WC_PROJECT_ID=your_walletconnect_project_id  # Optional
```

### 6. Run the Bot

**Development mode** (auto-reload on changes):

```bash
npm run dev
```

**Production mode**:

```bash
npm run build
npm start
```

## Running as a Service

### Using screen (simple)

```bash
screen -S nftbouncer
npm run dev
# Press Ctrl+A, D to detach
```

Reattach with `screen -r nftbouncer`.

### Using systemd (recommended for production)

Create `/etc/systemd/system/nft-bouncer.service`:

```ini
[Unit]
Description=BCH NFT Bouncer Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/bch_nft_bouncer_bot
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable nft-bouncer
sudo systemctl start nft-bouncer
```

## Project Structure

```
src/
├── index.ts              # Entry point
├── config.ts             # Environment config
├── polyfills.ts          # Node.js crypto polyfill for WalletConnect
├── bot/
│   ├── bot.ts            # grammY bot setup
│   ├── handlers/
│   │   ├── join.ts       # Member join handling
│   │   ├── verify.ts     # Verification flow
│   │   └── admin.ts      # Admin commands
│   └── middleware/
│       └── auth.ts       # Admin auth middleware
├── blockchain/
│   ├── wallet.ts         # Electrum connection
│   ├── nft.ts            # NFT ownership checks
│   ├── monitor.ts        # Transfer monitoring
│   └── verify.ts         # Signature verification
├── walletconnect/
│   ├── session.ts        # WC session management
│   ├── qr.ts             # QR code generation
│   └── sign.ts           # Sign message requests
└── storage/
    ├── db.ts             # SQLite setup
    ├── queries.ts        # Database queries
    └── types.ts          # TypeScript types
```

## Database

The bot uses SQLite, stored at `./data/bot.db` by default. Configure with `DB_PATH` environment variable.

Tables:
- `groups` - Registered groups
- `group_nft_categories` - NFT categories per group
- `verifications` - Verified users and their NFT bindings
- `challenges` - Pending verification challenges
- `pending_kicks` - Users awaiting verification

## Tech Stack

- **Runtime**: Node.js
- **Language**: TypeScript
- **Telegram Bot**: grammY
- **BCH/CashTokens**: mainnet-js
- **WalletConnect**: @walletconnect/sign-client
- **Storage**: SQLite (better-sqlite3)
- **QR Generation**: qrcode
