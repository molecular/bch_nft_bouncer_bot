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

    -- Verified users and their NFT bindings
    CREATE TABLE IF NOT EXISTS verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
      nft_category TEXT NOT NULL,
      nft_commitment TEXT,              -- NFT commitment (for uniqueness)
      bch_address TEXT NOT NULL,        -- Address holding the NFT
      verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(nft_category, nft_commitment)  -- Each NFT can only verify one user
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

    -- Track users who were kicked and need verification
    CREATE TABLE IF NOT EXISTS pending_kicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      kicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(telegram_user_id, group_id)
    );

    -- Create indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_verifications_user ON verifications(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_verifications_group ON verifications(group_id);
    CREATE INDEX IF NOT EXISTS idx_verifications_address ON verifications(bch_address);
    CREATE INDEX IF NOT EXISTS idx_challenges_user ON challenges(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_pending_kicks_user ON pending_kicks(telegram_user_id);
  `);

  // Migration: Add telegram_username column if it doesn't exist
  const columns = db.prepare("PRAGMA table_info(verifications)").all() as { name: string }[];
  if (!columns.some(col => col.name === 'telegram_username')) {
    db.exec("ALTER TABLE verifications ADD COLUMN telegram_username TEXT");
    console.log('Added telegram_username column to verifications table');
  }

  console.log('Database initialized');
}

export function closeDatabase(): void {
  db.close();
}
