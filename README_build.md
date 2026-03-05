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

The included `run_nftbouncer.sh` script handles auto-restart and log rotation:

```bash
screen -S nftbouncer
./run_nftbouncer.sh
# Press Ctrl+A, D to detach
```

Reattach with `screen -r nftbouncer`.

Logs are stored in `logs/bot-YYYY-MM-DD.log` with `bot.log` symlinked to the current day's log.

To restart the bot (from outside screen): `screen -S nftbouncer -X stuff $'\003'`

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
- `group_access_rules` - Access conditions (NFT requirements, balance thresholds)
- `verifications` - Verified user addresses (proves ownership, access computed dynamically)
- `challenges` - Pending verification challenges
- `pending_kicks` - Users currently restricted (awaiting verification or conditions not met)
- `token_metadata` - Cached BCMR token metadata

## Tech Stack

- **Runtime**: Node.js
- **Language**: TypeScript
- **Telegram Bot**: grammY
- **BCH/CashTokens**: mainnet-js
- **WalletConnect**: @walletconnect/sign-client
- **Storage**: SQLite (better-sqlite3)
- **QR Generation**: qrcode
