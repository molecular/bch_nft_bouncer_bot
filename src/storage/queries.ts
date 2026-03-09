import { db } from './db.js';
import { config } from '../config.js';
import type { Group, Verification, Challenge, GroupMembership, MembershipStatus, TokenMetadata, AccessRule, AccessRuleType } from './types.js';
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

// ============ NFT Categories (legacy - use addAccessRule for new code) ============

export function addNftCategory(groupId: number, category: string): void {
  // Add as NFT rule without range constraints (backwards compatible)
  db.prepare(`
    INSERT OR IGNORE INTO group_access_rules (group_id, rule_type, category)
    VALUES (?, 'nft', ?)
  `).run(groupId, category);
}

export function removeNftCategory(groupId: number, category: string): void {
  // Remove NFT rules for this category (removes all ranges)
  db.prepare(`
    DELETE FROM group_access_rules
    WHERE group_id = ? AND rule_type = 'nft' AND category = ?
  `).run(groupId, category);
}

// ============ Access Rules ============

export function addAccessRule(
  groupId: number,
  ruleType: AccessRuleType,
  category: string | null,
  options?: {
    startCommitment?: string;
    endCommitment?: string;
    minAmount?: string;
    label?: string;
  }
): number {
  const result = db.prepare(`
    INSERT INTO group_access_rules (group_id, rule_type, category, start_commitment, end_commitment, min_amount, label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    groupId,
    ruleType,
    category,
    options?.startCommitment ?? null,
    options?.endCommitment ?? null,
    options?.minAmount ?? null,
    options?.label ?? null
  );
  return result.lastInsertRowid as number;
}

export function getAccessRules(groupId: number): AccessRule[] {
  return db.prepare(`
    SELECT * FROM group_access_rules WHERE group_id = ? ORDER BY rule_type, id
  `).all(groupId) as AccessRule[];
}

export function getAccessRuleById(id: number): AccessRule | undefined {
  return db.prepare('SELECT * FROM group_access_rules WHERE id = ?')
    .get(id) as AccessRule | undefined;
}

export function removeAccessRule(id: number): boolean {
  const result = db.prepare('DELETE FROM group_access_rules WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getAccessRulesForGroup(groupId: number, ruleType?: AccessRuleType): AccessRule[] {
  if (ruleType) {
    return db.prepare(`
      SELECT * FROM group_access_rules WHERE group_id = ? AND rule_type = ? ORDER BY id
    `).all(groupId, ruleType) as AccessRule[];
  }
  return db.prepare(`
    SELECT * FROM group_access_rules WHERE group_id = ? ORDER BY rule_type, id
  `).all(groupId) as AccessRule[];
}

export function getNftCategories(groupId: number): string[] {
  // Query from new access rules table - returns unique categories from NFT rules
  const rows = db.prepare(`
    SELECT DISTINCT category FROM group_access_rules
    WHERE group_id = ? AND rule_type = 'nft' AND category IS NOT NULL
  `).all(groupId) as { category: string }[];
  return rows.map(r => r.category);
}

export function isGroupConfigured(groupId: number): boolean {
  // Check if group has any access rules configured
  const result = db.prepare('SELECT 1 FROM group_access_rules WHERE group_id = ? LIMIT 1')
    .get(groupId);
  return !!result;
}

// ============ Verifications ============

export function addVerification(
  telegramUserId: number,
  telegramUsername: string | null,
  bchAddress: string
): void {
  db.prepare(`
    INSERT INTO verifications (telegram_user_id, telegram_username, bch_address)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id, bch_address) DO UPDATE SET
      telegram_username = excluded.telegram_username,
      verified_at = CURRENT_TIMESTAMP
  `).run(telegramUserId, telegramUsername, bchAddress);
}

export function getVerificationByAddress(
  telegramUserId: number,
  bchAddress: string
): Verification | undefined {
  return db.prepare(`
    SELECT * FROM verifications WHERE telegram_user_id = ? AND bch_address = ?
  `).get(telegramUserId, bchAddress) as Verification | undefined;
}

export function getVerificationsForUser(telegramUserId: number): Verification[] {
  return db.prepare(`
    SELECT * FROM verifications WHERE telegram_user_id = ? ORDER BY id
  `).all(telegramUserId) as Verification[];
}

export function getVerificationById(id: number): Verification | undefined {
  return db.prepare('SELECT * FROM verifications WHERE id = ?').get(id) as Verification | undefined;
}

export function getVerificationsByAddress(bchAddress: string): Verification[] {
  return db.prepare('SELECT * FROM verifications WHERE bch_address = ?')
    .all(bchAddress) as Verification[];
}

export function deleteVerification(id: number): void {
  db.prepare('DELETE FROM verifications WHERE id = ?').run(id);
}

export function deleteVerificationsByUser(telegramUserId: number): void {
  db.prepare('DELETE FROM verifications WHERE telegram_user_id = ?')
    .run(telegramUserId);
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

// ============ Group Memberships ============

export function addGroupMembership(
  telegramUserId: number,
  groupId: number,
  status: MembershipStatus = 'restricted'
): void {
  db.prepare(`
    INSERT INTO group_memberships (telegram_user_id, group_id, status)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id, group_id) DO UPDATE SET
      status = excluded.status,
      joined_at = CURRENT_TIMESTAMP
  `).run(telegramUserId, groupId, status);
}

export function getGroupMembership(telegramUserId: number, groupId: number): GroupMembership | undefined {
  return db.prepare(`
    SELECT * FROM group_memberships WHERE telegram_user_id = ? AND group_id = ?
  `).get(telegramUserId, groupId) as GroupMembership | undefined;
}

export function getGroupMembershipsForUser(telegramUserId: number): GroupMembership[] {
  return db.prepare('SELECT * FROM group_memberships WHERE telegram_user_id = ?')
    .all(telegramUserId) as GroupMembership[];
}

export function getAllGroupMemberships(): GroupMembership[] {
  return db.prepare('SELECT * FROM group_memberships')
    .all() as GroupMembership[];
}

export function getRestrictedMembershipsForUser(telegramUserId: number): GroupMembership[] {
  return db.prepare(`
    SELECT * FROM group_memberships WHERE telegram_user_id = ? AND status = 'restricted'
  `).all(telegramUserId) as GroupMembership[];
}

export function deleteGroupMembership(telegramUserId: number, groupId: number): void {
  db.prepare('DELETE FROM group_memberships WHERE telegram_user_id = ? AND group_id = ?')
    .run(telegramUserId, groupId);
}

export function setMembershipStatus(
  userId: number,
  groupId: number,
  status: MembershipStatus
): void {
  db.prepare(`
    UPDATE group_memberships SET status = ? WHERE telegram_user_id = ? AND group_id = ?
  `).run(status, userId, groupId);
}

export function updateMembershipMessageId(telegramUserId: number, groupId: number, messageId: number): void {
  db.prepare('UPDATE group_memberships SET prompt_message_id = ? WHERE telegram_user_id = ? AND group_id = ?')
    .run(messageId, telegramUserId, groupId);
}

// Users past timeout threshold (restricted only)
export function getExpiredMemberships(timeoutMinutes: number): (GroupMembership & { group_name: string | null })[] {
  const stmt = db.prepare(`
    SELECT gm.*, g.name as group_name
    FROM group_memberships gm
    JOIN groups g ON gm.group_id = g.id
    WHERE gm.status = 'restricted'
      AND datetime(gm.joined_at, '+' || ? || ' minutes') < datetime('now')
  `);
  return stmt.all(timeoutMinutes) as (GroupMembership & { group_name: string | null })[];
}

// Users past warn threshold but not yet warned, and not yet expired (restricted only)
export function getMembershipsToWarn(warnMinutes: number, timeoutMinutes: number): (GroupMembership & { group_name: string | null })[] {
  const stmt = db.prepare(`
    SELECT gm.*, g.name as group_name
    FROM group_memberships gm
    JOIN groups g ON gm.group_id = g.id
    WHERE gm.status = 'restricted'
      AND datetime(gm.joined_at, '+' || ? || ' minutes') < datetime('now')
      AND datetime(gm.joined_at, '+' || ? || ' minutes') >= datetime('now')
      AND gm.warning_sent = 0
  `);
  return stmt.all(warnMinutes, timeoutMinutes) as (GroupMembership & { group_name: string | null })[];
}

export function markMembershipWarned(telegramUserId: number, groupId: number): void {
  const stmt = db.prepare(`
    UPDATE group_memberships SET warning_sent = 1
    WHERE telegram_user_id = ? AND group_id = ?
  `);
  stmt.run(telegramUserId, groupId);
}

// Legacy aliases for backwards compatibility during migration
export const addPendingKick = (userId: number, groupId: number) => addGroupMembership(userId, groupId, 'restricted');
export const getPendingKick = getGroupMembership;
export const getPendingKicksForUser = getRestrictedMembershipsForUser;
export const deletePendingKick = deleteGroupMembership;
export const updatePendingKickMessageId = updateMembershipMessageId;
export const getExpiredPendingKicks = getExpiredMemberships;
export const getPendingKicksToWarn = getMembershipsToWarn;
export const markPendingKickWarned = markMembershipWarned;

// ============ Monitoring Helpers ============

export function getAllVerifiedAddresses(): string[] {
  // Include all verified addresses - we monitor all of them
  const rows = db.prepare('SELECT DISTINCT bch_address FROM verifications')
    .all() as { bch_address: string }[];
  return rows.map(r => r.bch_address);
}

export function getAllConfiguredGroupIds(): number[] {
  const rows = db.prepare('SELECT DISTINCT group_id FROM group_access_rules')
    .all() as { group_id: number }[];
  return rows.map(r => r.group_id);
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
  decimals: number | null
): void {
  db.prepare(`
    INSERT INTO token_metadata (category, name, symbol, description, decimals, fetched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(category) DO UPDATE SET
      name = excluded.name,
      symbol = excluded.symbol,
      description = excluded.description,
      decimals = excluded.decimals,
      fetched_at = excluded.fetched_at
  `).run(category, name, symbol, description, decimals);
}

export function isTokenMetadataStale(category: string, maxAgeHours: number = 24): boolean {
  const metadata = getTokenMetadata(category);
  if (!metadata) return true;

  const fetchedAt = new Date(metadata.fetched_at).getTime();
  const now = Date.now();
  const ageMs = now - fetchedAt;
  return ageMs > maxAgeHours * 60 * 60 * 1000;
}
