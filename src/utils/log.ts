import { db } from '../storage/db.js';

// In-memory cache for fast username resolution
const usernameCache = new Map<number, string>();

/**
 * Unified logging function.
 * - Always writes to stdout with timestamp
 * - User-specific events also written to DB logs table
 * - System events (no userId) only go to stdout
 *
 * @param category - Log category (e.g., 'verify', 'join', 'monitor')
 * @param message - Log message
 * @param userId - Optional Telegram user ID (if present, writes to DB)
 * @param extra - Optional extra context (groupId, etc.)
 */
export function log(
  category: string,
  message: string,
  userId?: number,
  extra?: {
    groupId?: number;
    [key: string]: any;
  }
): void {
  const timestamp = new Date().toISOString();

  if (userId) {
    // User-specific: stdout with @username + DB write
    const username = usernameCache.get(userId);
    const userDisplay = username ? `@${username}` : `user:${userId}`;
    console.log(`${timestamp} [${category}] ${userDisplay} ${message}`);

    // Write to DB
    try {
      insertLog(timestamp, category, message, userId, extra?.groupId, extra);
    } catch (err) {
      // Don't let logging errors break the app
      console.error(`${timestamp} [log] Failed to write to DB:`, err);
    }
  } else {
    // System event: stdout only, no DB
    console.log(`${timestamp} [${category}] ${message}`);
  }
}

/**
 * Track a user we've seen (updates cache and DB).
 * Call this on join events, commands, etc.
 */
export function trackUser(
  userId: number,
  username?: string | null,
  firstName?: string | null
): void {
  // Update cache if we have a username
  if (username) {
    usernameCache.set(userId, username);
  }

  // Upsert to users table
  try {
    const stmt = db.prepare(`
      INSERT INTO users (telegram_user_id, username, first_name, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        username = COALESCE(excluded.username, users.username),
        first_name = COALESCE(excluded.first_name, users.first_name),
        updated_at = excluded.updated_at
    `);
    stmt.run(userId, username || null, firstName || null, new Date().toISOString());
  } catch (err) {
    // Don't let tracking errors break the app
    console.error('Failed to track user:', err);
  }
}

/**
 * Load username cache from DB on startup.
 */
export function initLogging(): void {
  try {
    const rows = db.prepare('SELECT telegram_user_id, username FROM users WHERE username IS NOT NULL').all() as {
      telegram_user_id: number;
      username: string;
    }[];

    for (const row of rows) {
      usernameCache.set(row.telegram_user_id, row.username);
    }

    log('startup', `Loaded ${usernameCache.size} usernames into cache`);
  } catch (err) {
    // Table might not exist yet on first run
    console.error('Failed to load username cache (table may not exist yet):', err);
  }
}

/**
 * Get username from cache (for external use if needed).
 */
export function getCachedUsername(userId: number): string | undefined {
  return usernameCache.get(userId);
}

/**
 * Insert a log entry into the database.
 */
function insertLog(
  timestamp: string,
  category: string,
  message: string,
  userId: number,
  groupId?: number,
  extra?: Record<string, any>
): void {
  // Remove groupId from extra to avoid duplication
  const { groupId: _, ...extraWithoutGroupId } = extra || {};
  const extraJson = Object.keys(extraWithoutGroupId).length > 0
    ? JSON.stringify(extraWithoutGroupId)
    : null;

  const stmt = db.prepare(`
    INSERT INTO logs (timestamp, category, message, telegram_user_id, group_id, extra)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(timestamp, category, message, userId, groupId || null, extraJson);
}
