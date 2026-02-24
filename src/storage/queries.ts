import { db } from './db.js';
import { config } from '../config.js';
import type { Group, Verification, Challenge, PendingKick, TokenMetadata } from './types.js';
import crypto from 'crypto';

// ============ Groups ============

export function upsertGroup(id: number, name: string | null): void {
  db.prepare(`
    INSERT INTO groups (id, name) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `).run(id, name);
}

export function getGroup(id: number): Group | undefined {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as Group | undefined;
}

export function deleteGroup(id: number): void {
  db.prepare('DELETE FROM groups WHERE id = ?').run(id);
}

// ============ NFT Categories ============

export function addNftCategory(groupId: number, category: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO group_nft_categories (group_id, category) VALUES (?, ?)
  `).run(groupId, category);
}

export function removeNftCategory(groupId: number, category: string): void {
  db.prepare('DELETE FROM group_nft_categories WHERE group_id = ? AND category = ?')
    .run(groupId, category);
}

export function getNftCategories(groupId: number): string[] {
  const rows = db.prepare('SELECT category FROM group_nft_categories WHERE group_id = ?')
    .all(groupId) as { category: string }[];
  return rows.map(r => r.category);
}

export function isGroupConfigured(groupId: number): boolean {
  const result = db.prepare('SELECT 1 FROM group_nft_categories WHERE group_id = ? LIMIT 1')
    .get(groupId);
  return !!result;
}

// ============ Verifications ============

export function addVerification(
  telegramUserId: number,
  telegramUsername: string | null,
  groupId: number,
  nftCategory: string,
  nftCommitment: string | null,
  bchAddress: string
): void {
  db.prepare(`
    INSERT INTO verifications (telegram_user_id, telegram_username, group_id, nft_category, nft_commitment, bch_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(telegramUserId, telegramUsername, groupId, nftCategory, nftCommitment, bchAddress);
}

export function getVerification(
  telegramUserId: number,
  groupId: number
): Verification | undefined {
  return db.prepare(`
    SELECT * FROM verifications WHERE telegram_user_id = ? AND group_id = ?
  `).get(telegramUserId, groupId) as Verification | undefined;
}

export function getVerificationByNft(
  nftCategory: string,
  nftCommitment: string | null,
  groupId: number
): Verification | undefined {
  if (nftCommitment === null) {
    return db.prepare(`
      SELECT * FROM verifications WHERE nft_category = ? AND nft_commitment IS NULL AND group_id = ?
    `).get(nftCategory, groupId) as Verification | undefined;
  }
  return db.prepare(`
    SELECT * FROM verifications WHERE nft_category = ? AND nft_commitment = ? AND group_id = ?
  `).get(nftCategory, nftCommitment, groupId) as Verification | undefined;
}

export function getVerificationsByAddress(bchAddress: string): Verification[] {
  return db.prepare('SELECT * FROM verifications WHERE bch_address = ?')
    .all(bchAddress) as Verification[];
}

export function deleteVerification(id: number): void {
  db.prepare('DELETE FROM verifications WHERE id = ?').run(id);
}

export function deleteVerificationsByUser(telegramUserId: number, groupId?: number): void {
  if (groupId !== undefined) {
    db.prepare('DELETE FROM verifications WHERE telegram_user_id = ? AND group_id = ?')
      .run(telegramUserId, groupId);
  } else {
    db.prepare('DELETE FROM verifications WHERE telegram_user_id = ?')
      .run(telegramUserId);
  }
}

// ============ Challenges ============

export function createChallenge(
  telegramUserId: number,
  groupId: number | null,
  bchAddress: string | null = null
): Challenge {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + config.challengeExpiryMinutes * 60 * 1000).toISOString();

  const result = db.prepare(`
    INSERT INTO challenges (telegram_user_id, group_id, nonce, bch_address, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(telegramUserId, groupId, nonce, bchAddress, expiresAt);

  return {
    id: result.lastInsertRowid as number,
    telegram_user_id: telegramUserId,
    group_id: groupId,
    nonce,
    bch_address: bchAddress,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  };
}

export function getActiveChallenge(telegramUserId: number): Challenge | undefined {
  return db.prepare(`
    SELECT * FROM challenges
    WHERE telegram_user_id = ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at DESC
    LIMIT 1
  `).get(telegramUserId) as Challenge | undefined;
}

export function updateChallengeAddress(challengeId: number, bchAddress: string): void {
  db.prepare('UPDATE challenges SET bch_address = ? WHERE id = ?')
    .run(bchAddress, challengeId);
}

export function deleteChallenge(id: number): void {
  db.prepare('DELETE FROM challenges WHERE id = ?').run(id);
}

export function cleanupExpiredChallenges(): void {
  db.prepare("DELETE FROM challenges WHERE expires_at < datetime('now')").run();
}

// ============ Pending Kicks ============

export function addPendingKick(telegramUserId: number, groupId: number): void {
  db.prepare(`
    INSERT OR REPLACE INTO pending_kicks (telegram_user_id, group_id)
    VALUES (?, ?)
  `).run(telegramUserId, groupId);
}

export function getPendingKick(telegramUserId: number, groupId: number): PendingKick | undefined {
  return db.prepare(`
    SELECT * FROM pending_kicks WHERE telegram_user_id = ? AND group_id = ?
  `).get(telegramUserId, groupId) as PendingKick | undefined;
}

export function getPendingKicksForUser(telegramUserId: number): PendingKick[] {
  return db.prepare('SELECT * FROM pending_kicks WHERE telegram_user_id = ?')
    .all(telegramUserId) as PendingKick[];
}

export function deletePendingKick(telegramUserId: number, groupId: number): void {
  db.prepare('DELETE FROM pending_kicks WHERE telegram_user_id = ? AND group_id = ?')
    .run(telegramUserId, groupId);
}

// ============ Monitoring Helpers ============

export function getAllVerifiedAddresses(): string[] {
  const rows = db.prepare('SELECT DISTINCT bch_address FROM verifications')
    .all() as { bch_address: string }[];
  return rows.map(r => r.bch_address);
}

export function getVerificationsForMonitoring(): Array<{
  id: number;
  telegram_user_id: number;
  group_id: number;
  nft_category: string;
  nft_commitment: string | null;
  bch_address: string;
}> {
  return db.prepare(`
    SELECT id, telegram_user_id, group_id, nft_category, nft_commitment, bch_address
    FROM verifications
  `).all() as Array<{
    id: number;
    telegram_user_id: number;
    group_id: number;
    nft_category: string;
    nft_commitment: string | null;
    bch_address: string;
  }>;
}

// ============ Token Metadata ============

export function getTokenMetadata(category: string): TokenMetadata | undefined {
  return db.prepare('SELECT * FROM token_metadata WHERE category = ?')
    .get(category) as TokenMetadata | undefined;
}

export function upsertTokenMetadata(
  category: string,
  name: string | null,
  symbol: string | null,
  description: string | null,
  iconUri: string | null,
  imageUri: string | null,
  decimals: number | null
): void {
  db.prepare(`
    INSERT INTO token_metadata (category, name, symbol, description, icon_uri, image_uri, decimals, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(category) DO UPDATE SET
      name = excluded.name,
      symbol = excluded.symbol,
      description = excluded.description,
      icon_uri = excluded.icon_uri,
      image_uri = excluded.image_uri,
      decimals = excluded.decimals,
      fetched_at = excluded.fetched_at
  `).run(category, name, symbol, description, iconUri, imageUri, decimals);
}

export function isTokenMetadataStale(category: string, maxAgeHours: number = 24): boolean {
  const metadata = getTokenMetadata(category);
  if (!metadata) return true;

  const fetchedAt = new Date(metadata.fetched_at).getTime();
  const now = Date.now();
  const ageMs = now - fetchedAt;
  return ageMs > maxAgeHours * 60 * 60 * 1000;
}
