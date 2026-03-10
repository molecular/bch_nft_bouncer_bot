import { getProvider } from './wallet.js';
import { checkAccessRulesMultiAddress } from './nft.js';
import { sendVerifiedMessage } from '../bot/utils/verification.js';
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

// Track when each address was added (to ignore notifications in first few seconds)
const addressAddedTimes = new Map<string, number>();

const SUBSCRIPTION_WARMUP_MS = 3000; // Ignore notifications for 3 seconds after subscribing

/**
 * Start monitoring verified addresses for NFT transfers
 */
export async function startMonitoring(bot: Bot): Promise<void> {
  if (botInstance) {
    console.log('Monitoring already running');
    return;
  }

  botInstance = bot;

  console.log('Starting NFT transfer monitoring...');

  // Subscribe to all existing verified addresses
  const addresses = getAllVerifiedAddresses();
  console.log(`[monitor] Subscribing to ${addresses.length} addresses`);
  for (const address of addresses) {
    await addAddressToMonitor(address);
  }

  // Run once on startup to catch anything missed while bot was down
  checkAllVerifications();
}

/**
 * Stop monitoring
 */
export function stopMonitoring(): void {
  // Cancel all subscriptions
  for (const [address, cancel] of addressSubscriptions) {
    try {
      cancel();
    } catch (e) {
      // Ignore cancellation errors
    }
  }
  addressSubscriptions.clear();
  addressAddedTimes.clear();

  botInstance = null;
  console.log('NFT monitoring stopped');
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
      // Ignore notifications during warmup period
      const addedTime = addressAddedTimes.get(address) || 0;
      if (Date.now() - addedTime < SUBSCRIPTION_WARMUP_MS) {
        return;
      }

      console.log(`[monitor] Address change: ${address}`);

      // Check all verifications for this address
      await checkAddressVerifications(address);
    });

    addressSubscriptions.set(address, cancel);
  } catch (error) {
    console.error(`[monitor] Failed to subscribe to ${address}:`, error);
  }
}

/**
 * Add an address to monitoring (subscribes to electrum notifications)
 */
export async function addAddressToMonitor(address: string): Promise<void> {
  if (addressSubscriptions.has(address)) {
    return; // Already monitoring
  }

  addressAddedTimes.set(address, Date.now());
  await subscribeToAddress(address);
  console.log(`[monitor] Now monitoring ${address} (${addressSubscriptions.size} total)`);
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
    addressAddedTimes.delete(address);
    console.log(`[monitor] Stopped monitoring ${address} (${addressSubscriptions.size} remaining)`);
  }
}

/**
 * Check all verifications for a specific address (triggered by subscription)
 */
async function checkAddressVerifications(address: string): Promise<void> {
  // Get all users who have verified this address
  const verifications = getVerificationsByAddress(address);
  const userIds = [...new Set(verifications.map(v => v.telegram_user_id))];

  console.log(`[subscription] Checking ${userIds.length} users for address ${address}`);

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
          console.log(`[subscription] No rules for group ${membership.group_id}, skipping`);
          continue;
        }

        // Check access rules against all user's addresses
        const result = await checkAccessRulesMultiAddress(userAddresses, rules);

        const isRestricted = membership.status === 'restricted';

        console.log(`[subscription] User ${userId} group ${membership.group_id}: status=${membership.status}, satisfied=${result.satisfied}`);

        // Check if condition state changed
        const newStateKey = getConditionStateKey(result);
        const oldStateKey = conditionStateCache.get(cacheKey);

        if (result.satisfied && isRestricted) {
          // Now qualifies - unrestrict
          console.log(`[subscription] User ${userId} now qualifies - granting access!`);
          conditionStateCache.set(cacheKey, newStateKey);
          await notifyConditionProgress(membership, rules, result);
          await grantAccess(membership, result);
        } else if (!result.satisfied && !isRestricted) {
          // No longer qualifies - restrict
          console.log(`[subscription] User ${userId} no longer qualifies - restricting`);
          conditionStateCache.set(cacheKey, newStateKey);
          await revokeAccess(membership);
        } else if (isRestricted && oldStateKey !== newStateKey) {
          // Still restricted but state changed - notify progress
          console.log(`[subscription] Condition state changed for user ${userId}`);
          conditionStateCache.set(cacheKey, newStateKey);
          await notifyConditionProgress(membership, rules, result);
        }
      } catch (error) {
        console.error(`[subscription] Error checking user ${userId} group ${membership.group_id}:`, error);
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
    console.error('Bot instance not available for granting access');
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

    // Send "verified" message to the group (with image if available)
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

    console.log(`[monitor] Granted access to user ${membership.telegram_user_id} in group ${membership.group_id}`);

    // Notify user via DM
    try {
      const group = getGroup(membership.group_id);
      const groupName = group?.name || `Group ${membership.group_id}`;

      // Try to get a link to the group
      let groupLink = '';
      try {
        const chat = await botInstance.api.getChat(membership.group_id);
        if ('username' in chat && chat.username) {
          groupLink = `\n\nGo to group: https://t.me/${chat.username}`;
        } else if ('invite_link' in chat && chat.invite_link) {
          groupLink = `\n\nGo to group: ${chat.invite_link}`;
        }
      } catch {
        // Ignore errors getting chat info
      }

      await botInstance.api.sendMessage(
        membership.telegram_user_id,
        `🎉 *Great news!*\n\n` +
        `Your wallet now meets the access requirements!\n\n` +
        `You now have full access to *${groupName}*.${groupLink}`,
        { parse_mode: 'Markdown' }
      );
    } catch (dmError) {
      // User may have blocked the bot
      console.log('Could not DM user about activation:', dmError);
    }

  } catch (error) {
    console.error(`Error granting access for user ${membership.telegram_user_id}:`, error);
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

    let msg = `*Condition Status for ${groupName}*\n\n`;
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
    console.log('Could not DM user about condition progress:', dmError);
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
                console.log(`[monitor] Restricted user ${membership.telegram_user_id} in group ${membership.group_id}`);
              }
            } catch (e) {
              // Ignore errors (user may have left, bot may not have permission)
            }
          }
        } else {
          // No longer qualifies - revoke access
          invalid++;
          console.log(`[monitor] User ${membership.telegram_user_id} no longer qualifies - will restrict`);
          await revokeAccess(membership);
        }
      }
    } catch (error) {
      errors++;
      console.error(
        `Error checking membership for user ${membership.telegram_user_id} group ${membership.group_id}:`,
        error
      );
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
  console.log(
    `[monitor] ${memberships.length} memberships | ${valid} valid, ${invalid} invalid${activatedInfo}${pendingInfo}, ${errors} errors | groups: ${groupInfo}`
  );
}

/**
 * Revoke access when user no longer meets conditions
 */
async function revokeAccess(membership: GroupMembership): Promise<void> {
  if (!botInstance) {
    console.error('Bot instance not available for revoking access');
    return;
  }

  try {
    // Check if user is admin/creator - don't restrict them
    const member = await botInstance.api.getChatMember(
      membership.group_id,
      membership.telegram_user_id
    );

    if (member.status === 'administrator' || member.status === 'creator') {
      console.log(`User ${membership.telegram_user_id} is admin/creator - not restricting`);
      return;
    }

    // Update membership status to restricted
    setMembershipStatus(membership.telegram_user_id, membership.group_id, 'restricted');

    // Restrict the user
    try {
      await botInstance.api.restrictChatMember(
        membership.group_id,
        membership.telegram_user_id,
        { can_send_messages: false }
      );
      console.log(`[monitor] Revoked access for user ${membership.telegram_user_id} in group ${membership.group_id}`);
    } catch (restrictError) {
      console.error('Could not restrict user:', restrictError);
    }

    // Send "restricted" message to the group
    try {
      let username = 'User';
      if ('user' in member && member.user) {
        username = member.user.username ? `@${member.user.username}` : member.user.first_name;
      }
      await botInstance.api.sendMessage(
        membership.group_id,
        `🚫 ${username} restricted (no longer meets requirements)`,
      );
    } catch {
      // May fail if bot can't send to the group
    }

    // Notify the user
    try {
      const group = getGroup(membership.group_id);
      const groupName = group?.name || `Group ${membership.group_id}`;
      await botInstance.api.sendMessage(
        membership.telegram_user_id,
        `⚠️ Your wallet no longer meets the access requirements for *${groupName}*.\n\n` +
        `You've been restricted until you meet the requirements again.\n\n` +
        `I'm still monitoring your address - you'll be automatically re-activated!`,
        { parse_mode: 'Markdown' }
      );
    } catch (dmError) {
      console.log('Could not DM user about restriction:', dmError);
    }

  } catch (error) {
    console.error(`Error revoking access for user ${membership.telegram_user_id}:`, error);
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

  for (const membership of memberships) {
    try {
      // If no rules left, all authorized users should be restricted
      if (rules.length === 0) {
        if (membership.status === 'authorized') {
          invalid++;
          await revokeAccess(membership);
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
        invalid++;
        console.log(`[monitor] Group check: user ${membership.telegram_user_id} no longer qualifies - will restrict`);
        await revokeAccess(membership);
      } else if (result.satisfied && isRestricted) {
        valid++;
        await grantAccess(membership, result);
      } else {
        valid++;
      }
    } catch (error) {
      console.error(`[monitor] Error checking membership for user ${membership.telegram_user_id}:`, error);
    }
  }

  return { checked: memberships.length, valid, invalid };
}
