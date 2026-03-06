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

-- Access rules for group gating (NFT with optional commitment ranges, or balance requirements)
CREATE TABLE group_access_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,          -- 'nft' or 'balance'
  category TEXT,                    -- Token category ID, or 'BCH' for BCH balance
  start_commitment TEXT,            -- Hex, inclusive (nft with range only)
  end_commitment TEXT,              -- Hex, inclusive (nft with range only)
  min_amount TEXT,                  -- BigInt as string (balance rules only)
  label TEXT,                       -- Human-readable (e.g., "Jessicas", "21 BCH Club")
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(group_id, rule_type, category, start_commitment, end_commitment)
);

-- Verified addresses: proves user owns address for a group
CREATE TABLE verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  bch_address TEXT NOT NULL,
  verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  telegram_username TEXT,
  UNIQUE(telegram_user_id, bch_address, group_id)
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

-- Track users who need verification (restricted until they qualify)
CREATE TABLE pending_kicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  kicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  prompt_message_id INTEGER,        -- Message ID of verification prompt in group
  warned_at DATETIME,               -- When user was warned about impending timeout
  UNIQUE(telegram_user_id, group_id)
);

-- Token metadata cache (BCMR)
CREATE TABLE token_metadata (
  category TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  description TEXT,
  icon_uri TEXT,
  image_uri TEXT,
  decimals INTEGER,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

### Phase 6.6: Pending Verifications & Dynamic Condition Checking
- [x] Simplified verifications table (just address proof, no specific NFT binding)
- [x] Allow verification before acquiring qualifying asset
- [x] Re-evaluate on address change or group rules change
- [x] Auto-grant/revoke access based on current conditions
- [x] Expiration for pending verifications (Phase 9 integration)

### Phase 7 (Future): Lobby Model
- [ ] Public lobby for discovery
- [ ] Route verified users to appropriate private groups
- [ ] One lobby → many gated groups

### Phase 8: Message Cleanup
- [x] Store message_id when posting group verification notification in join.ts
- [x] After successful verification, delete the group notification message
- [x] Send "user verified" message to group with NFT info
- [x] Requires bot to have "Delete messages" permission
- [x] Handle gracefully: message already deleted, >48h old, no permission

### Phase 9: Kick Unverified Users After Timeout
- [x] Track when user was first restricted (pending_kicks table has kicked_at)
- [x] Periodic check for users who've been pending too long (default 30 min)
- [x] Kick users who haven't verified within the timeout
- [x] Configurable timeout via env vars (PENDING_VERIFICATION_TIMEOUT_MINUTES, PENDING_VERIFICATION_WARN_MINUTES)
- [x] Warn user via DM before kicking (at 20 min by default)

### Phase 10: NFT Image in Verified Announcements
- [x] Fix BCMR parsing to extract `uris.icon` and `token.symbol`
- [x] Resolve IPFS URIs to gateway URLs
- [x] Image fetching and resizing module (sharp)
- [x] Show NFT info in "user verified" group announcements
- [x] Attach image to "user verified" announcements with sendPhoto
- [x] Graceful fallback to text-only if no image

### Phase 10b (Future): Image Caching
- [ ] Cache resized images in SQLite to avoid repeated fetches
- [ ] Periodic refresh for stale images

### Phase 11: Balance Threshold & Commitment Range Gating
Support gating by asset balances and NFT commitment ranges.

**Asset types:**
- BCH balance (e.g., "21 BCH club")
- Fungible CashToken balance (e.g., "hold 1000 FURU tokens")
- NFT with commitment range (e.g., "Jessicas #01-#64")

**Multiple conditions:**
- Group can have multiple rules
- NFT rules: OR (at least one must be satisfied)
- Balance rules: OR (at least one must be satisfied)
- Between types: AND (need at least one of each type configured)

**Implementation:**
- [x] Evolved `group_nft_categories` to `group_access_rules` with rule types
- [x] Rule types: 'nft' (category + optional commitment range), 'balance' (category + min amount)
- [x] NFT rules support commitment ranges (start_commitment, end_commitment)
- [x] Balance rules support BCH or fungible tokens
- [x] Address subscriptions watch all transactions
- [x] Re-evaluate on any address change (unified with Phase 6.6 logic)
- [x] `/add_condition nft <cat> [label] [start] [end]` command
- [x] `/add_condition balance <amount> <BCH|cat>` command
- [x] `/remove_condition` accepts ID or name matching

### Phase 12 (Future): Cross-Group Verification Reuse
When a user joins a new group, automatically check if they have verified addresses elsewhere that qualify for access.

**Problem:** Users must verify separately for each group, even with the same address.

**Approach: Auto-reuse on join**
- When user joins a group, check all their verified addresses (from any group)
- If any address satisfies the new group's conditions, auto-grant access
- Keep `group_id` in verifications table for per-group control
- User can `/unverify` if they don't want reuse

**Implementation:**
- [ ] Query all user's verified addresses across groups on join
- [ ] Check each address against new group's access rules
- [ ] If qualifying address found, create verification for new group + grant access
- [ ] Skip the kick/DM flow entirely for reused verifications
- [ ] Log reuse events for transparency

### Phase 13 (Future): HODL/VOX Vault Verification
Support checking coin lockups in HODL plugin or VOX vault as access conditions.
- [ ] Research HODL plugin API/contract structure
- [ ] Research VOX vault API/contract structure
- [ ] Add 'lockup' rule type to group_access_rules
- [ ] Implement lockup balance checking

### Phase 14 (Future): Privacy Mode
User-selectable privacy mode that hides which specific NFT was used for verification.
- [ ] Add privacy preference to verifications table
- [ ] Offer privacy toggle during verification flow
- [ ] "✅ @user verified!" only (no NFT details) when enabled
- [ ] Group admin option to require/disable privacy mode

### Phase 15 (Future): Optional NFT Image/Commitment Display
Admin toggle for showing NFT images and/or commitment IDs in verification announcements.
- [ ] Add display settings to groups table (show_nft_image, show_commitment)
- [ ] Admin commands to configure display options
- [ ] Respect settings in sendVerifiedMessage()

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
PENDING_VERIFICATION_TIMEOUT_MINUTES=30  # Kick unverified users after this many minutes
PENDING_VERIFICATION_WARN_MINUTES=20     # Warn users this many minutes before timeout
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
