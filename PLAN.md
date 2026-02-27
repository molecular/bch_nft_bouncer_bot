# NFT Entry Bot - Implementation Plan

## Overview
Telegram bot that gates group access based on Bitcoin Cash NFT (CashToken) ownership. Similar to captcha bots, but requires cryptographic proof of NFT ownership instead.

## Tech Stack
- **Runtime**: Node.js (v18+)
- **Language**: TypeScript
- **Telegram Bot**: grammY
- **BCH/CashTokens**: mainnet.js v3
- **WalletConnect**: @walletconnect/sign-client + wc2-bch-bcr spec
- **Storage**: SQLite (better-sqlite3 for sync API, or sqlite3)
- **QR Generation**: qrcode (npm package)

## Core Features

### 1. Group Access Control
- Public group (discoverable via search)
- **Hidden message history** for new members (Telegram setting)
- Instant kick on join → verification via DM → re-add when verified
- Per-group NFT category configuration

### 2. NFT Ownership Verification (Two Methods)

**Method A: WalletConnect (preferred UX)**
1. Bot sends QR code image in DM
2. User scans with BCH wallet
3. Bot calls `bch_getAddresses` → gets user's address
4. Bot checks NFT ownership via `wallet.getTokenUtxos(category)`
5. Bot calls `bch_signMessage` with challenge (nonce + timestamp + group ID)
6. User approves in wallet
7. Bot verifies signature → grants access

**Method B: Manual Signature (fallback)**
1. Bot sends challenge text: `"Verify NFT ownership for [group]: nonce=[random] time=[timestamp]"`
2. User copies message, signs in wallet (Electron Cash, etc.)
3. User pastes signature back to bot
4. Bot verifies signature matches address holding NFT → grants access

### 3. NFT Binding & Transfer Monitoring
- Each NFT can only verify ONE Telegram user (prevents sharing)
- Store mapping: `{ nftId (category:commitment) → telegramUserId, address, groupId }`
- Monitor blockchain via mainnet.js `watchTokenTransactions()` or polling
- When NFT transfers out of verified address → auto-kick user from group

### 4. Per-Group Configuration
Stored in SQLite `groups` table.

## Database Schema

```sql
-- Groups the bot manages
CREATE TABLE groups (
  id INTEGER PRIMARY KEY,           -- Telegram chat ID
  name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- NFT categories that grant access to each group
CREATE TABLE group_nft_categories (
  group_id INTEGER REFERENCES groups(id),
  category TEXT,                    -- CashToken category ID (hex)
  PRIMARY KEY (group_id, category)
);

-- Verified users and their NFT bindings
CREATE TABLE verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  group_id INTEGER REFERENCES groups(id),
  nft_category TEXT NOT NULL,
  nft_commitment TEXT,              -- NFT commitment (for uniqueness)
  bch_address TEXT NOT NULL,        -- Address holding the NFT
  verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(nft_category, nft_commitment)  -- Each NFT can only verify one user
);

-- Pending verification challenges
CREATE TABLE challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  group_id INTEGER,
  nonce TEXT NOT NULL,
  bch_address TEXT,                 -- Address user claims to own
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
);
```

## Project Structure
```
nft_entry_bot/
├── src/
│   ├── index.ts              # Entry point
│   ├── bot/
│   │   ├── bot.ts            # grammY bot setup
│   │   ├── handlers/
│   │   │   ├── join.ts       # Handle member joins (kick + DM)
│   │   │   ├── verify.ts     # Verification command/flow
│   │   │   └── admin.ts      # Admin commands (config NFT categories)
│   │   └── middleware/
│   │       └── auth.ts       # Admin auth middleware
│   ├── blockchain/
│   │   ├── wallet.ts         # mainnet.js connection
│   │   ├── nft.ts            # NFT ownership checks
│   │   ├── monitor.ts        # Transfer monitoring
│   │   └── verify.ts         # Signature verification
│   ├── walletconnect/
│   │   ├── session.ts        # WC session management
│   │   ├── qr.ts             # QR code generation
│   │   └── sign.ts           # Sign message requests
│   ├── storage/
│   │   ├── db.ts             # SQLite connection + migrations
│   │   ├── queries.ts        # DB query functions
│   │   └── types.ts          # Data types
│   └── config.ts             # Environment config
├── data/
│   └── bot.db                # SQLite database
├── package.json
├── tsconfig.json
└── .env                      # BOT_TOKEN, WC_PROJECT_ID, ELECTRUM_SERVER
```

## Implementation Phases

### Phase 1: Project Setup
- [x] Initialize project (package.json, tsconfig.json)
- [x] grammY bot skeleton with /start command
- [x] SQLite setup with schema migrations
- [x] Environment config (.env)

### Phase 2: BCH Integration + Manual Verification
- [x] mainnet.js electrum connection
- [x] NFT ownership check (`getTokenUtxos(category)`)
- [x] Challenge generation (nonce + timestamp)
- [x] Manual signature verification (Bitcoin Signed Message format)
- [x] /verify command: prompt address → check NFT → send challenge → verify sig

### Phase 3: Group Gating
- [x] Detect member join events
- [x] Instant kick on join
- [x] DM user with verification prompt
- [x] Re-add user on successful verification
- [x] NFT-to-user binding storage (prevent reuse)

### Phase 4: Admin & Config
- [x] Per-group NFT category configuration
- [x] Admin commands (/setnft, /status)
- [x] Multiple groups support

### Phase 5: Transfer Monitoring + Auto-Kick
- [x] Monitor verified addresses via electrum subscriptions
- [x] Detect when NFT transfers out
- [x] Auto-kick user, clean up binding

### Phase 6: WalletConnect (Enhancement)
- [x] Register at cloud.walletconnect.com for Project ID
- [x] WC session initialization
- [x] QR code generation and sending in DM
- [x] `bch_getAddresses` + `bch_signMessage` flow
- [x] Offer WC as primary option, manual as fallback

### Phase 6.5: BCMR Token Metadata
- [x] Fetch token metadata from Paytaca BCMR API
- [x] Cache metadata in SQLite (token_metadata table)
- [x] Display token names instead of category IDs in all user-facing messages
- [x] Graceful fallback to truncated category ID if no metadata

### Phase 7 (Future): Lobby Model
- [ ] Public lobby for discovery
- [ ] Route verified users to appropriate private groups
- [ ] One lobby → many gated groups

### Phase 8 (Future): Message Cleanup
- [ ] Store message_id when posting group verification notification in join.ts
- [ ] After successful verification, delete the group notification message
- [ ] Requires bot to have "Delete messages" permission
- [ ] Handle gracefully: message already deleted, >48h old, no permission

### Phase 9 (Future): Kick Unverified Users After Timeout
- [ ] Track when user was first restricted (pending_kicks table has created_at)
- [ ] Periodic check for users who've been pending too long (e.g., 1 hour)
- [ ] Kick users who haven't verified within the timeout
- [ ] Configurable timeout per group (or global default)
- [ ] Maybe warn user via DM before kicking

### Phase 10 (Future): Image Caching
- [ ] Download and cache token icons/images as blobs in SQLite
- [ ] Resolve IPFS URIs to gateway URLs or fetch directly
- [ ] Use cached images for "user verified" group announcements
- [ ] Periodic refresh for stale images

### Phase 11 (Future): Balance Threshold Gating
- [ ] Support gating by BCH balance (e.g., "21 BCH club")
- [ ] Configure minimum balance per group
- [ ] Address subscriptions already watch all transactions, not just tokens
- [ ] Check balance on address change notification

## Key Dependencies
```json
{
  "grammy": "^1.x",
  "mainnet-js": "^3.x",
  "better-sqlite3": "^11.x",
  "@walletconnect/sign-client": "^2.x",
  "qrcode": "^1.x",
  "dotenv": "^16.x"
}
```

## Environment Variables
```
BOT_TOKEN=telegram_bot_token
WC_PROJECT_ID=walletconnect_project_id
ELECTRUM_SERVER=wss://... (or default)
```

## Verification Testing
1. Create test Telegram group, add bot as admin
2. Set group to hidden history for new members
3. Configure NFT category via admin command
4. Test join → kick → DM → verify → re-add flow
5. Test with WalletConnect wallet (if available)
6. Test manual signature fallback
7. Test NFT transfer → auto-kick

## Open Questions / Notes
- Need WalletConnect Project ID from cloud.walletconnect.com
- Which BCH wallets currently support WC2? (Cashonize, Paytaca?)
- Signature format: Base64, compatible with Electron Cash `\x18Bitcoin Signed Message:\n` prefix
