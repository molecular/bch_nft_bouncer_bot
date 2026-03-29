import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config.js';
import path from 'path';
import fs from 'fs';

// Ensure data directory exists
const dataDir = path.dirname(config.dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db: DatabaseType = new Database(config.dbPath);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

export function initializeDatabase(): void {
  db.exec(`
    -- Groups the bot manages
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY,           -- Telegram chat ID
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- NFT categories that grant access to each group
    CREATE TABLE IF NOT EXISTS group_nft_categories (
      group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      category TEXT,                    -- CashToken category ID (hex)
      PRIMARY KEY (group_id, category)
    );

    -- Verified addresses: proves user owns address (global, not per-group)
    CREATE TABLE IF NOT EXISTS verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      bch_address TEXT NOT NULL,
      verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      telegram_username TEXT,
      UNIQUE(telegram_user_id, bch_address)
    );

    -- Pending verification challenges
    CREATE TABLE IF NOT EXISTS challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      group_id INTEGER,
      nonce TEXT NOT NULL,
      bch_address TEXT,                 -- Address user claims to own
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    );

    -- Track group memberships and their access status
    CREATE TABLE IF NOT EXISTS group_memberships (
      telegram_user_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'restricted',  -- 'restricted' | 'authorized'
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      warning_sent BOOLEAN DEFAULT 0,
      kick_at DATETIME,
      prompt_message_id INTEGER,
      PRIMARY KEY (telegram_user_id, group_id)
    );

    -- Token metadata cache (BCMR)
    CREATE TABLE IF NOT EXISTS token_metadata (
      category TEXT PRIMARY KEY,
      name TEXT,
      symbol TEXT,
      description TEXT,
      decimals INTEGER,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Access rules for group gating (NFT with optional commitment ranges, or balance requirements)
    CREATE TABLE IF NOT EXISTS group_access_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      rule_type TEXT NOT NULL,        -- 'nft' or 'balance'
      category TEXT,                  -- Token category ID, or 'BCH' for BCH balance
      start_commitment TEXT,          -- Hex, inclusive (nft with range only)
      end_commitment TEXT,            -- Hex, inclusive (nft with range only)
      min_amount TEXT,                -- BigInt as string (balance rules only)
      label TEXT,                     -- Human-readable (e.g., "Jessicas", "21 BCH Club")
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, rule_type, category, start_commitment, end_commitment)
    );

    -- Track all users we've seen (for username lookup in logs)
    CREATE TABLE IF NOT EXISTS users (
      telegram_user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      updated_at TEXT NOT NULL
    );

    -- Persistent logs for per-user analysis (user events only)
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      telegram_user_id INTEGER,
      group_id INTEGER,
      extra TEXT  -- JSON for additional context
    );

    -- Create indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_verifications_user ON verifications(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_verifications_address ON verifications(bch_address);
    CREATE INDEX IF NOT EXISTS idx_challenges_user ON challenges(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_group_memberships_user ON group_memberships(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_group_memberships_group ON group_memberships(group_id);
    CREATE INDEX IF NOT EXISTS idx_access_rules_group ON group_access_rules(group_id);
    CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
  `);

  // Migration: Simplify verifications table - remove nft_category/nft_commitment and status
  // Verifications now just prove address ownership, conditions are checked dynamically
  const columns = db.prepare("PRAGMA table_info(verifications)").all() as { name: string }[];
  if (columns.some(col => col.name === 'nft_category') || columns.some(col => col.name === 'status')) {
    console.log('Migrating verifications table (removing nft_category/status)...');
    db.exec(`
      -- Create new simplified table (no status - access computed dynamically)
      CREATE TABLE verifications_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL,
        group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
        bch_address TEXT NOT NULL,
        verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        telegram_username TEXT,
        UNIQUE(telegram_user_id, bch_address, group_id)
      );

      -- Copy data (skip duplicate user+address+group combinations)
      INSERT OR IGNORE INTO verifications_new (telegram_user_id, group_id, bch_address, verified_at, telegram_username)
        SELECT telegram_user_id, group_id, bch_address, verified_at, telegram_username
        FROM verifications;

      -- Drop old table and rename
      DROP TABLE verifications;
      ALTER TABLE verifications_new RENAME TO verifications;

      -- Recreate indexes
      CREATE INDEX idx_verifications_user ON verifications(telegram_user_id);
      CREATE INDEX idx_verifications_group ON verifications(group_id);
      CREATE INDEX idx_verifications_address ON verifications(bch_address);
    `);
    console.log('Migrated verifications table (removed nft_category/status)');
  }

  // Migration: Remove group_id from verifications table (make verifications global)
  const verificationCols = db.prepare("PRAGMA table_info(verifications)").all() as { name: string }[];
  if (verificationCols.some(col => col.name === 'group_id')) {
    console.log('Migrating verifications table to global schema (removing group_id)...');
    db.exec(`
      CREATE TABLE verifications_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL,
        bch_address TEXT NOT NULL,
        verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        telegram_username TEXT,
        UNIQUE(telegram_user_id, bch_address)
      );

      -- Copy data, deduplicating by user+address (keep earliest verified_at)
      INSERT OR IGNORE INTO verifications_new
        (telegram_user_id, bch_address, verified_at, telegram_username)
      SELECT telegram_user_id, bch_address, MIN(verified_at), telegram_username
      FROM verifications
      GROUP BY telegram_user_id, bch_address;

      DROP TABLE verifications;
      ALTER TABLE verifications_new RENAME TO verifications;

      -- Recreate indexes (no longer need group index)
      CREATE INDEX idx_verifications_user ON verifications(telegram_user_id);
      CREATE INDEX idx_verifications_address ON verifications(bch_address);
    `);
    console.log('Migrated verifications to global schema');
  }

  // Migration: Rename pending_kicks to group_memberships with status column
  const hasPendingKicks = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_kicks'"
  ).get();
  if (hasPendingKicks) {
    console.log('Migrating pending_kicks to group_memberships...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS group_memberships (
        telegram_user_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'restricted',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        warning_sent BOOLEAN DEFAULT 0,
        kick_at DATETIME,
        prompt_message_id INTEGER,
        PRIMARY KEY (telegram_user_id, group_id)
      );

      -- Copy data from pending_kicks (all existing entries are 'restricted')
      INSERT OR IGNORE INTO group_memberships
        (telegram_user_id, group_id, status, joined_at, warning_sent, kick_at, prompt_message_id)
      SELECT
        telegram_user_id,
        group_id,
        'restricted',
        kicked_at,
        CASE WHEN warned_at IS NOT NULL THEN 1 ELSE 0 END,
        NULL,
        prompt_message_id
      FROM pending_kicks;

      DROP TABLE pending_kicks;

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_group_memberships_user ON group_memberships(telegram_user_id);
      CREATE INDEX IF NOT EXISTS idx_group_memberships_group ON group_memberships(group_id);
    `);
    console.log('Migrated pending_kicks to group_memberships');
  }

  // Migration: Copy data from group_nft_categories to group_access_rules if needed
  const accessRulesCount = db.prepare('SELECT COUNT(*) as count FROM group_access_rules').get() as { count: number };
  const nftCategoriesCount = db.prepare('SELECT COUNT(*) as count FROM group_nft_categories').get() as { count: number };

  if (accessRulesCount.count === 0 && nftCategoriesCount.count > 0) {
    db.exec(`
      INSERT INTO group_access_rules (group_id, rule_type, category)
      SELECT group_id, 'nft', category FROM group_nft_categories
    `);
    console.log(`Migrated ${nftCategoriesCount.count} NFT categories to access rules`);
  }

  // Migration: Drop icon_uri and image_uri columns from token_metadata (removed for privacy)
  const tokenMetadataColumns = db.prepare("PRAGMA table_info(token_metadata)").all() as { name: string }[];
  if (tokenMetadataColumns.some(col => col.name === 'icon_uri')) {
    console.log('Removing icon_uri and image_uri columns from token_metadata...');
    // SQLite doesn't support DROP COLUMN directly in older versions, so recreate the table
    db.exec(`
      CREATE TABLE token_metadata_new (
        category TEXT PRIMARY KEY,
        name TEXT,
        symbol TEXT,
        description TEXT,
        decimals INTEGER,
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO token_metadata_new (category, name, symbol, description, decimals, fetched_at)
        SELECT category, name, symbol, description, decimals, fetched_at FROM token_metadata;

      DROP TABLE token_metadata;
      ALTER TABLE token_metadata_new RENAME TO token_metadata;
    `);
    console.log('Removed icon_uri and image_uri columns from token_metadata');
  }

  // Migration: Populate users table with existing usernames from verifications
  const usersCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  if (usersCount.count === 0) {
    const result = db.prepare(`
      INSERT OR IGNORE INTO users (telegram_user_id, username, first_name, updated_at)
      SELECT telegram_user_id, telegram_username, NULL, datetime('now')
      FROM verifications
      WHERE telegram_username IS NOT NULL
    `).run();
    if (result.changes > 0) {
      console.log(`Populated users table with ${result.changes} usernames from verifications`);
    }
  }

  console.log('Database initialized');
}

export function closeDatabase(): void {
  db.close();
}
