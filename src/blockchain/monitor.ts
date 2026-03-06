import { getProvider } from './wallet.js';
import { checkAccessRulesMultiAddress } from './nft.js';
import { sendVerifiedMessage } from '../bot/utils/verification.js';
import { getVerificationsForMonitoring, deleteVerification, getNftCategories, getGroup, getAllVerifiedAddresses, deletePendingKick, getAccessRules, getPendingKick, addPendingKick } from '../storage/queries.js';
import { unrestrictUser } from '../bot/utils/permissions.js';
import { escapeMarkdown } from '../bot/utils/format.js';
import { formatRequirementsMessage } from '../bot/handlers/verify.js';
import type { Bot } from 'grammy';
import type { AccessRule } from '../storage/types.js';

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

      console.log(`[monitor] Address change: ${address.slice(0, 25)}...`);

      // Check all verifications for this address
      await checkAddressVerifications(address);
    });

    addressSubscriptions.set(address, cancel);
  } catch (error) {
    console.error(`[monitor] Failed to subscribe to ${address.slice(0, 25)}...:`, error);
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
  console.log(`[monitor] Now monitoring ${address.slice(0, 25)}... (${addressSubscriptions.size} total)`);
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
    console.log(`[monitor] Stopped monitoring ${address.slice(0, 25)}... (${addressSubscriptions.size} remaining)`);
  }
}

/**
 * Check all verifications for a specific address (triggered by subscription)
 */
async function checkAddressVerifications(address: string): Promise<void> {
  const verifications = getVerificationsForMonitoring().filter(
    v => v.bch_address === address
  );

  console.log(`[subscription] Checking ${verifications.length} verifications for ${address.slice(0, 25)}...`);

  // Group by user+group to avoid duplicate checks
  const userGroupMap = new Map<string, typeof verifications[0]>();
  for (const v of verifications) {
    const key = `${v.telegram_user_id}:${v.group_id}`;
    if (!userGroupMap.has(key)) {
      userGroupMap.set(key, v);
    }
  }

  for (const [key, verification] of userGroupMap) {
    try {
      const rules = getAccessRules(verification.group_id);

      // If no rules configured, skip
      if (rules.length === 0) {
        console.log(`[subscription] No rules for group ${verification.group_id}, skipping`);
        continue;
      }

      // Get all addresses for this user in this group
      const userVerifications = getVerificationsForMonitoring().filter(
        v => v.telegram_user_id === verification.telegram_user_id && v.group_id === verification.group_id
      );
      const userAddresses = [...new Set(userVerifications.map(v => v.bch_address))];

      // Check access rules against all user's addresses
      const result = await checkAccessRulesMultiAddress(userAddresses, rules);

      // Check if user is currently restricted (has pending_kick)
      const isRestricted = !!getPendingKick(verification.telegram_user_id, verification.group_id);

      console.log(`[subscription] User ${verification.telegram_user_id} group ${verification.group_id}: restricted=${isRestricted}, satisfied=${result.satisfied}, nft=${result.nftSatisfied}, balance=${result.balanceSatisfied}`);

      // Check if condition state changed
      const cacheKey = key;
      const newStateKey = getConditionStateKey(result);
      const oldStateKey = conditionStateCache.get(cacheKey);

      if (result.satisfied && isRestricted) {
        // Now qualifies - unrestrict
        console.log(`[subscription] User ${verification.telegram_user_id} now qualifies - granting access!`);
        conditionStateCache.set(cacheKey, newStateKey);
        await notifyConditionProgress(verification, rules, result);
        await grantAccess(verification, result);
      } else if (!result.satisfied && !isRestricted) {
        // No longer qualifies - restrict
        console.log(`[subscription] User ${verification.telegram_user_id} no longer qualifies - restricting`);
        conditionStateCache.set(cacheKey, newStateKey);
        await revokeAccess(verification);
      } else if (isRestricted && oldStateKey !== newStateKey) {
        // Still restricted but state changed - notify progress
        console.log(`[subscription] Condition state changed for user ${verification.telegram_user_id}`);
        conditionStateCache.set(cacheKey, newStateKey);
        await notifyConditionProgress(verification, rules, result);
      }
    } catch (error) {
      console.error(`[subscription] Error checking verification ${verification.id}:`, error);
    }
  }
}

/**
 * Grant access to user when they meet conditions
 */
async function grantAccess(
  verification: { id: number; telegram_user_id: number; group_id: number; bch_address: string },
  result?: Awaited<ReturnType<typeof checkAccessRulesMultiAddress>>
): Promise<void> {
  if (!botInstance) {
    console.error('Bot instance not available for granting access');
    return;
  }

  try {
    // Get pending kick info BEFORE deleting (need prompt_message_id)
    const pendingKick = getPendingKick(verification.telegram_user_id, verification.group_id);

    // Remove from pending kicks (marks them as having access)
    deletePendingKick(verification.telegram_user_id, verification.group_id);

    // Clear cached status message
    const cacheKey = `${verification.telegram_user_id}:${verification.group_id}`;
    statusMessageCache.delete(cacheKey);

    // Check if user is admin/owner - if so, skip unrestrict (they don't need it)
    let isAdmin = false;
    try {
      const member = await botInstance.api.getChatMember(verification.group_id, verification.telegram_user_id);
      isAdmin = member.status === 'administrator' || member.status === 'creator';
    } catch {
      // If we can't check, try to unrestrict anyway
    }

    if (!isAdmin) {
      await unrestrictUser(botInstance.api, verification.group_id, verification.telegram_user_id);
    }

    // Delete the verification prompt message from the group
    if (pendingKick?.prompt_message_id) {
      try {
        await botInstance.api.deleteMessage(verification.group_id, pendingKick.prompt_message_id);
      } catch {
        // Message may have been deleted or is too old
      }
    }

    // Send "verified" message to the group (with image if available)
    try {
      // Try to get the user's name
      let username = 'User';
      try {
        const member = await botInstance.api.getChatMember(verification.group_id, verification.telegram_user_id);
        if ('user' in member && member.user) {
          username = member.user.username ? `@${member.user.username}` : member.user.first_name;
        }
      } catch {
        // Ignore errors getting user info
      }

      // Extract matching NFT info if available
      let matchingNft: { category: string; commitment?: string } | undefined;
      if (result) {
        const satisfiedNft = result.nftResults.find(r => r.satisfied && r.matchingNft);
        if (satisfiedNft?.matchingNft) {
          matchingNft = {
            category: satisfiedNft.matchingNft.category,
            commitment: satisfiedNft.matchingNft.commitment || undefined,
          };
        }
      }

      await sendVerifiedMessage(botInstance.api, verification.group_id, username, matchingNft);
    } catch {
      // May fail if bot can't send to the group
    }

    console.log(`[monitor] Granted access to user ${verification.telegram_user_id} in group ${verification.group_id}`);

    // Notify user via DM
    try {
      const group = getGroup(verification.group_id);
      const groupName = escapeMarkdown(group?.name || `Group ${verification.group_id}`);

      // Try to get a link to the group
      let groupLink = '';
      try {
        const chat = await botInstance.api.getChat(verification.group_id);
        if ('username' in chat && chat.username) {
          groupLink = `\n\nGo to group: https://t.me/${escapeMarkdown(chat.username)}`;
        } else if ('invite_link' in chat && chat.invite_link) {
          groupLink = `\n\nGo to group: ${escapeMarkdown(chat.invite_link)}`;
        }
      } catch {
        // Ignore errors getting chat info
      }

      await botInstance.api.sendMessage(
        verification.telegram_user_id,
        `🎉 **Great news!**\n\n` +
        `Your wallet now meets the access requirements!\n\n` +
        `You now have full access to **${groupName}**.${groupLink}`,
        { parse_mode: 'Markdown' }
      );
    } catch (dmError) {
      // User may have blocked the bot
      console.log('Could not DM user about activation:', dmError);
    }

  } catch (error) {
    console.error(`Error activating pending verification ${verification.id}:`, error);
  }
}

/**
 * Notify user of condition progress (some conditions changed but not fully satisfied)
 */
async function notifyConditionProgress(
  verification: { id: number; telegram_user_id: number; group_id: number; bch_address: string },
  rules: AccessRule[],
  result: Awaited<ReturnType<typeof checkAccessRulesMultiAddress>>
): Promise<void> {
  if (!botInstance) return;

  const cacheKey = `${verification.telegram_user_id}:${verification.group_id}`;

  try {
    const group = getGroup(verification.group_id);
    const groupName = escapeMarkdown(group?.name || `Group ${verification.group_id}`);

    let msg = `📊 **Condition Status for ${groupName}**\n\n`;
    msg += await formatRequirementsMessage(rules, result);

    // Add status summary
    if (result.satisfied) {
      msg += `✅ _All requirements satisfied!_`;
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
          verification.telegram_user_id,
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
      verification.telegram_user_id,
      msg,
      { parse_mode: 'Markdown' }
    );
    statusMessageCache.set(cacheKey, sentMsg.message_id);

  } catch (dmError) {
    console.log('Could not DM user about condition progress:', dmError);
  }
}

/**
 * Check all verifications and kick users who no longer qualify
 */
async function checkAllVerifications(): Promise<void> {
  const verifications = getVerificationsForMonitoring();

  if (verifications.length === 0) {
    return;
  }

  // Aggregate stats
  let valid = 0;
  let invalid = 0;
  let activated = 0;
  let pending = 0;
  let errors = 0;
  const groupCounts = new Map<number, number>();

  // Group verifications by user+group to handle multi-address checking
  const userGroupMap = new Map<string, typeof verifications>();
  for (const v of verifications) {
    const key = `${v.telegram_user_id}:${v.group_id}`;
    if (!userGroupMap.has(key)) {
      userGroupMap.set(key, []);
    }
    userGroupMap.get(key)!.push(v);
  }

  for (const [key, userVerifications] of userGroupMap) {
    const verification = userVerifications[0]; // Representative verification
    groupCounts.set(verification.group_id, (groupCounts.get(verification.group_id) || 0) + 1);

    try {
      // Get access rules for this group
      const rules = getAccessRules(verification.group_id);

      // If no rules, skip
      if (rules.length === 0) continue;

      // Get all addresses for this user in this group
      const userAddresses = [...new Set(userVerifications.map(v => v.bch_address))];

      // Check access rules against all user's addresses
      const result = await checkAccessRulesMultiAddress(userAddresses, rules);

      // Check if user is currently restricted
      const isRestricted = !!getPendingKick(verification.telegram_user_id, verification.group_id);

      if (result.satisfied) {
        if (isRestricted) {
          // Now qualifies - grant access
          await grantAccess(verification, result);
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
                verification.group_id,
                verification.telegram_user_id
              );
              if (member.status !== 'administrator' && member.status !== 'creator' && member.status !== 'restricted') {
                await botInstance.api.restrictChatMember(
                  verification.group_id,
                  verification.telegram_user_id,
                  { can_send_messages: false }
                );
                console.log(`[monitor] Restricted user ${verification.telegram_user_id} in group ${verification.group_id}`);
              }
            } catch (e) {
              // Ignore errors (user may have left, bot may not have permission)
            }
          }
        } else {
          // No longer qualifies - revoke access
          invalid++;
          console.log(`[monitor] User ${verification.telegram_user_id} no longer qualifies - will restrict`);
          await revokeAccess(verification);
        }
      }
    } catch (error) {
      errors++;
      console.error(
        `Error checking verification ${verification.id}:`,
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
    `[monitor] ${userGroupMap.size} user-groups | ${valid} valid, ${invalid} invalid${activatedInfo}${pendingInfo}, ${errors} errors | groups: ${groupInfo}`
  );
}

/**
 * Revoke access when user no longer meets conditions
 */
async function revokeAccess(verification: {
  id: number;
  telegram_user_id: number;
  group_id: number;
  bch_address: string;
}): Promise<void> {
  if (!botInstance) {
    console.error('Bot instance not available for revoking access');
    return;
  }

  try {
    // Check if user is admin/creator - don't restrict them
    const member = await botInstance.api.getChatMember(
      verification.group_id,
      verification.telegram_user_id
    );

    if (member.status === 'administrator' || member.status === 'creator') {
      console.log(`User ${verification.telegram_user_id} is admin/creator - not restricting`);
      return;
    }

    // Add to pending kicks (marks them as restricted)
    addPendingKick(verification.telegram_user_id, verification.group_id);

    // Restrict the user
    try {
      await botInstance.api.restrictChatMember(
        verification.group_id,
        verification.telegram_user_id,
        { can_send_messages: false }
      );
      console.log(`[monitor] Revoked access for user ${verification.telegram_user_id} in group ${verification.group_id}`);
    } catch (restrictError) {
      console.error('Could not restrict user:', restrictError);
    }

    // Notify the user
    try {
      const group = getGroup(verification.group_id);
      const groupName = escapeMarkdown(group?.name || `Group ${verification.group_id}`);
      await botInstance.api.sendMessage(
        verification.telegram_user_id,
        `⚠️ Your wallet no longer meets the access requirements for **${groupName}**.\n\n` +
        `You've been restricted until you meet the requirements again.\n\n` +
        `I'm still monitoring your address - you'll be automatically re-activated!`,
        { parse_mode: 'Markdown' }
      );
    } catch (dmError) {
      console.log('Could not DM user about restriction:', dmError);
    }

  } catch (error) {
    console.error(`Error revoking access for user ${verification.telegram_user_id}:`, error);
  }
}

/**
 * Manually trigger a check for a specific user
 */
export async function checkUserVerification(
  telegramUserId: number,
  groupId: number
): Promise<boolean> {
  const verifications = getVerificationsForMonitoring().filter(
    v => v.telegram_user_id === telegramUserId && v.group_id === groupId
  );

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
 * Check all verifications for a specific group (e.g., after condition removal)
 */
export async function checkGroupVerifications(groupId: number): Promise<{
  checked: number;
  valid: number;
  invalid: number;
}> {
  const verifications = getVerificationsForMonitoring().filter(
    v => v.group_id === groupId
  );

  const rules = getAccessRules(groupId);

  let valid = 0;
  let invalid = 0;

  // Group by user to handle multi-address
  const userMap = new Map<number, typeof verifications>();
  for (const v of verifications) {
    if (!userMap.has(v.telegram_user_id)) {
      userMap.set(v.telegram_user_id, []);
    }
    userMap.get(v.telegram_user_id)!.push(v);
  }

  for (const [userId, userVerifications] of userMap) {
    const verification = userVerifications[0];

    try {
      // If no rules left, all users with verifications should be restricted
      if (rules.length === 0) {
        const isRestricted = !!getPendingKick(userId, groupId);
        if (!isRestricted) {
          invalid++;
          await revokeAccess(verification);
        }
        continue;
      }

      // Get all addresses for this user
      const userAddresses = [...new Set(userVerifications.map(v => v.bch_address))];

      // Check access rules
      const result = await checkAccessRulesMultiAddress(userAddresses, rules);
      const isRestricted = !!getPendingKick(userId, groupId);

      if (!result.satisfied && !isRestricted) {
        invalid++;
        console.log(`[monitor] Group check: user ${userId} no longer qualifies - will restrict`);
        await revokeAccess(verification);
      } else if (result.satisfied && isRestricted) {
        valid++;
        await grantAccess(verification, result);
      } else {
        valid++;
      }
    } catch (error) {
      console.error(`[monitor] Error checking verification ${verification.id}:`, error);
    }
  }

  return { checked: userMap.size, valid, invalid };
}
