import { getProvider, startHeartbeat, stopHeartbeat, setOnReconnect } from './wallet.js';
import { checkAccessRulesMultiAddress } from './nft.js';
import { sendVerifiedMessage, sendRestrictedMessage, escapeMarkdown } from '../bot/utils/verification.js';
import {
  getVerificationsForUser,
  getVerificationsByAddress,
  getNftCategories,
  getGroup,
  getAllVerifiedAddresses,
  getAllGroupMemberships,
  getGroupMembership,
  getGroupMembershipsForUser,
  setMembershipStatus,
  deleteGroupMembership,
  getAccessRules,
} from '../storage/queries.js';
import { unrestrictUser } from '../bot/utils/permissions.js';
import { formatRequirementsMessage } from '../bot/handlers/verify.js';
import type { Bot } from 'grammy';
import type { AccessRule, GroupMembership } from '../storage/types.js';
import { log } from '../utils/log.js';

// Track condition state per user-group to detect changes
// Key: "userId:groupId", Value: serialized satisfied rule IDs
const conditionStateCache = new Map<string, string>();

// Track the last status message ID per user-group so we can edit it
// Key: "userId:groupId", Value: message_id
const statusMessageCache = new Map<string, number>();

function getConditionStateKey(result: Awaited<ReturnType<typeof checkAccessRulesMultiAddress>>): string {
  const satisfiedNfts = result.nftResults.filter(r => r.satisfied).map(r => r.rule.id).sort();
  const satisfiedBalances = result.balanceResults.filter(r => r.satisfied).map(r => r.rule.id).sort();
  return `nft:${satisfiedNfts.join(',')};bal:${satisfiedBalances.join(',')}`;
}

let botInstance: Bot | null = null;

// Track subscriptions: address -> cancel function
const addressSubscriptions = new Map<string, () => void>();

/**
 * Start monitoring verified addresses for NFT transfers
 */
export async function startMonitoring(bot: Bot): Promise<void> {
  if (botInstance) {
    log('monitor', 'already running');
    return;
  }

  botInstance = bot;

  log('monitor', 'Starting NFT transfer monitoring...');

  // Set up reconnection handler to restore subscriptions after connection loss
  setOnReconnect(async () => {
    log('monitor', 'Connection restored - resubscribing to addresses...');
    await resubscribeAllAddresses();
  });

  // Start connection health monitoring
  startHeartbeat();

  // Subscribe to all existing verified addresses
  const addresses = getAllVerifiedAddresses();
  log('monitor', `Subscribing to ${addresses.length} addresses`);
  for (const address of addresses) {
    await addAddressToMonitor(address);
  }

  // Run once on startup to catch anything missed while bot was down
  checkAllVerifications();
}

/**
 * Resubscribe to all addresses after connection loss
 */
async function resubscribeAllAddresses(): Promise<void> {
  // Clear old (dead) subscriptions
  addressSubscriptions.clear();

  // Resubscribe to all verified addresses
  const addresses = getAllVerifiedAddresses();
  log('monitor', `Resubscribing to ${addresses.length} addresses`);
  for (const address of addresses) {
    await addAddressToMonitor(address);
  }

  // Re-check all verifications in case anything changed while disconnected
  checkAllVerifications();
}

/**
 * Stop monitoring
 */
export function stopMonitoring(): void {
  // Stop connection health monitoring
  stopHeartbeat();

  // Cancel all subscriptions
  for (const [address, cancel] of addressSubscriptions) {
    try {
      cancel();
    } catch (e) {
      // Ignore cancellation errors
    }
  }
  addressSubscriptions.clear();

  botInstance = null;
  log('monitor', 'NFT monitoring stopped');
}

/**
 * Subscribe to an address for transaction notifications
 */
async function subscribeToAddress(address: string): Promise<void> {
  if (addressSubscriptions.has(address)) {
    return; // Already subscribed
  }

  try {
    const provider = await getProvider();

    const cancel = await provider.subscribeToAddress(address, async (status: any) => {
      log('monitor', `Address change: ${address}`);

      // Check all verifications for this address
      await checkAddressVerifications(address);
    });

    addressSubscriptions.set(address, cancel);
  } catch (error) {
    log('monitor', `Failed to subscribe to ${address}: ${error}`);
  }
}

/**
 * Add an address to monitoring (subscribes to electrum notifications)
 */
export async function addAddressToMonitor(address: string): Promise<void> {
  if (addressSubscriptions.has(address)) {
    return; // Already monitoring
  }

  await subscribeToAddress(address);
  log('monitor', `Now monitoring ${address} (${addressSubscriptions.size} total)`);
}

/**
 * Remove an address from monitoring
 */
export function removeAddressFromMonitor(address: string): void {
  const cancel = addressSubscriptions.get(address);
  if (cancel) {
    try {
      cancel();
    } catch (e) {
      // Ignore cancellation errors
    }
    addressSubscriptions.delete(address);
    log('monitor', `Stopped monitoring ${address} (${addressSubscriptions.size} remaining)`);
  }
}

/**
 * Check all verifications for a specific address (triggered by subscription)
 */
async function checkAddressVerifications(address: string): Promise<void> {
  // Get all users who have verified this address
  const verifications = getVerificationsByAddress(address);
  const userIds = [...new Set(verifications.map(v => v.telegram_user_id))];

  log('subscription', `Checking ${userIds.length} users for address ${address}`);

  for (const userId of userIds) {
    // Get all memberships for this user
    const memberships = getGroupMembershipsForUser(userId);
    // Get all user's verified addresses
    const userVerifications = getVerificationsForUser(userId);
    const userAddresses = [...new Set(userVerifications.map(v => v.bch_address))];

    for (const membership of memberships) {
      const cacheKey = `${userId}:${membership.group_id}`;

      try {
        const rules = getAccessRules(membership.group_id);

        // If no rules configured, skip
        if (rules.length === 0) {
          continue;
        }

        // Check access rules against all user's addresses
        const result = await checkAccessRulesMultiAddress(userAddresses, rules);

        const isRestricted = membership.status === 'restricted';

        // Check if condition state changed
        const newStateKey = getConditionStateKey(result);
        const oldStateKey = conditionStateCache.get(cacheKey);

        if (result.satisfied && isRestricted) {
          // Now qualifies - unrestrict
          log('subscription', 'now qualifies - granting access!', userId, { groupId: membership.group_id });
          conditionStateCache.set(cacheKey, newStateKey);
          await notifyConditionProgress(membership, rules, result);
          await grantAccess(membership, result);
        } else if (!result.satisfied && !isRestricted) {
          // No longer qualifies - restrict
          log('subscription', 'no longer qualifies - restricting', userId, { groupId: membership.group_id });
          conditionStateCache.set(cacheKey, newStateKey);
          await revokeAccess(membership);
        } else if (isRestricted && oldStateKey !== newStateKey) {
          // Still restricted but state changed - notify progress
          log('subscription', 'condition state changed', userId, { groupId: membership.group_id });
          conditionStateCache.set(cacheKey, newStateKey);
          await notifyConditionProgress(membership, rules, result);
        }
      } catch (error) {
        log('subscription', `error checking: ${error}`, userId, { groupId: membership.group_id });
      }
    }
  }
}

/**
 * Grant access to user when they meet conditions
 */
async function grantAccess(
  membership: GroupMembership,
  result?: Awaited<ReturnType<typeof checkAccessRulesMultiAddress>>
): Promise<void> {
  if (!botInstance) {
    log('monitor', 'Bot instance not available for granting access');
    return;
  }

  // Re-check membership status to avoid race condition with concurrent callbacks
  // (e.g., user has multiple verified addresses that all get activity events at once)
  const currentMembership = getGroupMembership(membership.telegram_user_id, membership.group_id);
  if (currentMembership?.status === 'authorized') {
    log('monitor', 'already authorized, skipping duplicate grant', membership.telegram_user_id, { groupId: membership.group_id });
    return;
  }

  try {
    // Update membership status to authorized
    setMembershipStatus(membership.telegram_user_id, membership.group_id, 'authorized');

    // Clear cached status message
    const cacheKey = `${membership.telegram_user_id}:${membership.group_id}`;
    statusMessageCache.delete(cacheKey);

    // Check if user is admin/owner - if so, skip unrestrict (they don't need it)
    let isAdmin = false;
    try {
      const member = await botInstance.api.getChatMember(membership.group_id, membership.telegram_user_id);
      isAdmin = member.status === 'administrator' || member.status === 'creator';
    } catch {
      // If we can't check, try to unrestrict anyway
    }

    if (!isAdmin) {
      await unrestrictUser(botInstance.api, membership.group_id, membership.telegram_user_id);
    }

    // Delete the verification prompt message from the group
    if (membership.prompt_message_id) {
      try {
        await botInstance.api.deleteMessage(membership.group_id, membership.prompt_message_id);
      } catch {
        // Message may have been deleted or is too old
      }
    }

    // Send "verified" message to the group (skip for admins)
    if (!isAdmin) {
      try {
        // Try to get the user's name
        let username = 'User';
        try {
          const member = await botInstance.api.getChatMember(membership.group_id, membership.telegram_user_id);
          if ('user' in member && member.user) {
            username = member.user.username ? `@${member.user.username}` : member.user.first_name;
          }
        } catch {
          // Ignore errors getting user info
        }

        await sendVerifiedMessage(botInstance.api, membership.group_id, username);
      } catch {
        // May fail if bot can't send to the group
      }
    }

    log('monitor', 'granted access', membership.telegram_user_id, { groupId: membership.group_id });

    // Notify user via DM
    try {
      const group = getGroup(membership.group_id);
      const groupName = group?.name || `Group ${membership.group_id}`;

      // Try to get a link to the group
      let groupLink = '';
      try {
        const chat = await botInstance.api.getChat(membership.group_id);
        if ('username' in chat && chat.username) {
          // Use Markdown link syntax to avoid underscore parsing issues
          groupLink = `\n\n[Go to ${escapeMarkdown(groupName)}](https://t.me/${chat.username})`;
        } else if ('invite_link' in chat && chat.invite_link) {
          groupLink = `\n\n[Go to ${escapeMarkdown(groupName)}](${chat.invite_link})`;
        }
      } catch {
        // Ignore errors getting chat info
      }

      await botInstance.api.sendMessage(
        membership.telegram_user_id,
        `🎉 *Great news!*\n\n` +
        `Your wallet now meets the access requirements!\n\n` +
        `You now have full access to *${escapeMarkdown(groupName)}*.${groupLink}`,
        { parse_mode: 'Markdown' }
      );
    } catch (dmError) {
      // User may have blocked the bot
      log('monitor', `could not DM about activation: ${dmError}`, membership.telegram_user_id);
    }

  } catch (error) {
    log('monitor', `error granting access: ${error}`, membership.telegram_user_id, { groupId: membership.group_id });
  }
}

/**
 * Notify user of condition progress (some conditions changed but not fully satisfied)
 */
async function notifyConditionProgress(
  membership: GroupMembership,
  rules: AccessRule[],
  result: Awaited<ReturnType<typeof checkAccessRulesMultiAddress>>
): Promise<void> {
  if (!botInstance) return;

  const cacheKey = `${membership.telegram_user_id}:${membership.group_id}`;

  try {
    const group = getGroup(membership.group_id);
    const groupName = group?.name || `Group ${membership.group_id}`;

    let msg = `*Condition Status for ${escapeMarkdown(groupName)}*\n\n`;
    msg += await formatRequirementsMessage(rules, result);

    // Add status summary
    if (result.satisfied) {
      msg += `_All requirements satisfied!_ 👍`;
    } else if (result.nftSatisfied && !result.balanceSatisfied) {
      msg += `_NFT requirement satisfied! Still need a balance condition._`;
    } else if (!result.nftSatisfied && result.balanceSatisfied) {
      msg += `_Balance requirement satisfied! Still need an NFT condition._`;
    } else {
      msg += `_Some conditions met - keep going!_`;
    }

    // Try to edit existing message, otherwise send new
    const existingMsgId = statusMessageCache.get(cacheKey);
    if (existingMsgId) {
      try {
        await botInstance.api.editMessageText(
          membership.telegram_user_id,
          existingMsgId,
          msg,
          { parse_mode: 'Markdown' }
        );
        return; // Successfully edited
      } catch (editError) {
        // Edit failed (message too old, deleted, etc.) - send new message
      }
    }

    // Send new message and cache its ID
    const sentMsg = await botInstance.api.sendMessage(
      membership.telegram_user_id,
      msg,
      { parse_mode: 'Markdown' }
    );
    statusMessageCache.set(cacheKey, sentMsg.message_id);

  } catch (dmError) {
    log('monitor', `could not DM about condition progress: ${dmError}`, membership.telegram_user_id);
  }
}

/**
 * Check all memberships and update access status
 */
async function checkAllVerifications(): Promise<void> {
  const memberships = getAllGroupMemberships();

  if (memberships.length === 0) {
    return;
  }

  // Aggregate stats
  let valid = 0;
  let invalid = 0;
  let activated = 0;
  let pending = 0;
  let errors = 0;
  const groupCounts = new Map<number, number>();

  for (const membership of memberships) {
    groupCounts.set(membership.group_id, (groupCounts.get(membership.group_id) || 0) + 1);

    try {
      // Get access rules for this group
      const rules = getAccessRules(membership.group_id);

      // If no rules, skip
      if (rules.length === 0) continue;

      // Get all addresses for this user (global verifications)
      const userVerifications = getVerificationsForUser(membership.telegram_user_id);
      const userAddresses = [...new Set(userVerifications.map(v => v.bch_address))];

      // Check access rules against all user's addresses
      const result = await checkAccessRulesMultiAddress(userAddresses, rules);

      // Check current status
      const isRestricted = membership.status === 'restricted';

      if (result.satisfied) {
        if (isRestricted) {
          // Now qualifies - grant access
          await grantAccess(membership, result);
          activated++;
        } else {
          valid++;
        }
      } else {
        if (isRestricted) {
          // Still doesn't qualify - ensure user is restricted
          pending++;
          if (botInstance) {
            try {
              const member = await botInstance.api.getChatMember(
                membership.group_id,
                membership.telegram_user_id
              );
              if (member.status !== 'administrator' && member.status !== 'creator' && member.status !== 'restricted') {
                await botInstance.api.restrictChatMember(
                  membership.group_id,
                  membership.telegram_user_id,
                  { can_send_messages: false }
                );
                log('monitor', 'restricted (pending verification)', membership.telegram_user_id, { groupId: membership.group_id });
              }
            } catch (e) {
              // Ignore errors (user may have left, bot may not have permission)
            }
          }
        } else {
          // No longer qualifies - revoke access
          invalid++;
          log('monitor', 'no longer qualifies - will restrict', membership.telegram_user_id, { groupId: membership.group_id });
          await revokeAccess(membership);
        }
      }
    } catch (error) {
      errors++;
      log('monitor', `error checking membership: ${error}`, membership.telegram_user_id, { groupId: membership.group_id });
    }
  }

  // Log summary
  const groupInfo = Array.from(groupCounts.entries())
    .map(([gid, count]) => {
      const group = getGroup(gid);
      const name = group?.name || String(gid);
      return `${name}:${count}`;
    })
    .join(', ');
  const activatedInfo = activated > 0 ? `, ${activated} activated` : '';
  const pendingInfo = pending > 0 ? `, ${pending} pending` : '';
  log('monitor', `${memberships.length} memberships | ${valid} valid, ${invalid} invalid${activatedInfo}${pendingInfo}, ${errors} errors | groups: ${groupInfo}`);
}

/**
 * Revoke access when user no longer meets conditions
 * Returns user info if successfully restricted (for batched notifications)
 */
async function revokeAccess(
  membership: GroupMembership,
  options?: { skipGroupMessage?: boolean }
): Promise<{ userId: number; displayName: string } | null> {
  if (!botInstance) {
    log('monitor', 'Bot instance not available for revoking access');
    return null;
  }

  try {
    // Check if user is admin/creator - don't restrict them but still track status
    const member = await botInstance.api.getChatMember(
      membership.group_id,
      membership.telegram_user_id
    );

    const isAdmin = member.status === 'administrator' || member.status === 'creator';

    // Update membership status to restricted
    setMembershipStatus(membership.telegram_user_id, membership.group_id, 'restricted');

    if (isAdmin) {
      log('monitor', 'admin/creator - status updated but not restricting', membership.telegram_user_id, { groupId: membership.group_id });
      return null;
    }

    // Get display name for return value
    let displayName = 'User';
    if ('user' in member && member.user) {
      displayName = member.user.username ? `@${member.user.username}` : member.user.first_name;
    }

    // Restrict the user
    try {
      await botInstance.api.restrictChatMember(
        membership.group_id,
        membership.telegram_user_id,
        { can_send_messages: false }
      );
      log('monitor', 'revoked access', membership.telegram_user_id, { groupId: membership.group_id });
    } catch (restrictError) {
      log('monitor', `could not restrict: ${restrictError}`, membership.telegram_user_id, { groupId: membership.group_id });
    }

    // Send "restricted" message to the group (unless batching)
    if (!options?.skipGroupMessage) {
      try {
        await sendRestrictedMessage(botInstance.api, membership.group_id, displayName);
      } catch {
        // May fail if bot can't send to the group
      }
    }

    // Notify the user
    try {
      const group = getGroup(membership.group_id);
      const groupName = group?.name || `Group ${membership.group_id}`;
      const botUsername = botInstance.botInfo.username;
      const verifyLink = `https://t.me/${botUsername}?start=verify_${membership.group_id}`;

      // Try to get group link so user can find the group again
      let groupNameDisplay = `*${escapeMarkdown(groupName)}*`;
      try {
        const chat = await botInstance.api.getChat(membership.group_id);
        if ('username' in chat && chat.username) {
          groupNameDisplay = `[${escapeMarkdown(groupName)}](https://t.me/${chat.username})`;
        } else if ('invite_link' in chat && chat.invite_link) {
          groupNameDisplay = `[${escapeMarkdown(groupName)}](${chat.invite_link})`;
        }
      } catch {
        // Keep bold name if we can't get link
      }

      await botInstance.api.sendMessage(
        membership.telegram_user_id,
        `⚠️ Your wallet no longer meets the access requirements for ${groupNameDisplay}.\n\n` +
        `You've been restricted. Verify to regain access: ${verifyLink}`,
        { parse_mode: 'Markdown' }
      );
    } catch (dmError) {
      log('monitor', `could not DM about restriction: ${dmError}`, membership.telegram_user_id);
    }

    return { userId: membership.telegram_user_id, displayName };

  } catch (error) {
    log('monitor', `error revoking access: ${error}`, membership.telegram_user_id, { groupId: membership.group_id });
    return null;
  }
}

/**
 * Manually trigger a check for a specific user
 */
export async function checkUserVerification(
  telegramUserId: number,
  groupId: number
): Promise<boolean> {
  const verifications = getVerificationsForUser(telegramUserId);

  if (verifications.length === 0) {
    return false;
  }

  const rules = getAccessRules(groupId);
  if (rules.length === 0) {
    return false;
  }

  const userAddresses = [...new Set(verifications.map(v => v.bch_address))];
  const result = await checkAccessRulesMultiAddress(userAddresses, rules);

  return result.satisfied;
}

/**
 * Check all memberships for a specific group (e.g., after condition removal)
 */
export async function checkGroupVerifications(groupId: number): Promise<{
  checked: number;
  valid: number;
  invalid: number;
}> {
  const memberships = getAllGroupMemberships().filter(m => m.group_id === groupId);
  const rules = getAccessRules(groupId);

  let valid = 0;
  let invalid = 0;
  const restrictedUsers: { userId: number; displayName: string }[] = [];

  for (const membership of memberships) {
    try {
      // If no rules left, everyone is allowed - grant access to restricted users
      if (rules.length === 0) {
        if (membership.status === 'restricted') {
          valid++;
          await grantAccess(membership, { satisfied: true, nftSatisfied: true, balanceSatisfied: true, nftResults: [], balanceResults: [] });
        } else {
          valid++;
        }
        continue;
      }

      // Get all addresses for this user (global verifications)
      const userVerifications = getVerificationsForUser(membership.telegram_user_id);
      const userAddresses = [...new Set(userVerifications.map(v => v.bch_address))];

      // Check access rules
      const result = await checkAccessRulesMultiAddress(userAddresses, rules);
      const isRestricted = membership.status === 'restricted';

      if (!result.satisfied && !isRestricted) {
        // Authorized user no longer qualifies -> revoke
        invalid++;
        log('monitor', 'group check: no longer qualifies - will restrict', membership.telegram_user_id, { groupId });
        const userInfo = await revokeAccess(membership, { skipGroupMessage: true });
        if (userInfo) restrictedUsers.push(userInfo);
      } else if (result.satisfied && isRestricted) {
        // Restricted user now qualifies -> grant access
        valid++;
        await grantAccess(membership, result);
      } else if (result.satisfied) {
        // Authorized user still qualifies
        valid++;
      }
      // else: restricted user still doesn't qualify - no action, not counted as valid
    } catch (error) {
      log('monitor', `error checking membership: ${error}`, membership.telegram_user_id, { groupId });
    }
  }

  // Send batched group notification if any users were restricted
  if (restrictedUsers.length > 0 && botInstance) {
    try {
      const botUsername = botInstance.botInfo.username;
      const verifyLink = `https://t.me/${botUsername}?start=verify_${groupId}`;

      // Format user mentions - use text mention for users without @ username
      const formatMention = (u: { userId: number; displayName: string }) => {
        if (u.displayName.startsWith('@')) {
          return u.displayName; // Already has @username
        }
        return `[${u.displayName}](tg://user?id=${u.userId})`;
      };

      let msg: string;
      if (restrictedUsers.length === 1) {
        msg = `👎 ${formatMention(restrictedUsers[0])} no longer meets requirements and has been restricted.\n\n` +
              `Verify again: ${verifyLink}`;
      } else {
        const mentions = restrictedUsers.map(formatMention).join(', ');
        msg = `👎 ${restrictedUsers.length} users no longer meet requirements and have been restricted:\n` +
              mentions + `\n\n` +
              `Verify again: ${verifyLink}`;
      }

      await botInstance.api.sendMessage(groupId, msg, { parse_mode: 'Markdown' });
    } catch {
      // May fail if bot can't send to the group
    }
  }

  return { checked: memberships.length, valid, invalid };
}
