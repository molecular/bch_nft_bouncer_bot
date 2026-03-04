import { getProvider } from './wallet.js';
import { isNftAtAddress, checkNftOwnership, checkAccessRules, checkAccessRulesMultiAddress } from './nft.js';
import { getVerificationsForMonitoring, deleteVerification, updateVerificationNft, updateVerificationStatus, getNftCategories, getGroup, getAllVerifiedAddresses, getPendingVerificationsByAddress, deletePendingKick, getAccessRules } from '../storage/queries.js';
import { unrestrictUser } from '../bot/utils/permissions.js';
import { escapeMarkdown } from '../bot/utils/format.js';
import type { Bot } from 'grammy';
import type { AccessRule } from '../storage/types.js';

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

  for (const verification of verifications) {
    try {
      const rules = getAccessRules(verification.group_id);

      // If no rules configured, skip
      if (rules.length === 0) continue;

      // Get all addresses for this user in this group (for multi-address verification)
      const userVerifications = getVerificationsForMonitoring().filter(
        v => v.telegram_user_id === verification.telegram_user_id && v.group_id === verification.group_id
      );
      const userAddresses = [...new Set(userVerifications.map(v => v.bch_address))];

      // Check access rules against all user's addresses
      const result = await checkAccessRulesMultiAddress(userAddresses, rules);

      if (verification.status === 'pending') {
        // Pending verification - check if now qualifies
        if (result.satisfied) {
          // Find matching NFT if any for the record
          const nftResult = result.nftResults.find(r => r.satisfied && r.matchingNft);
          const nft = nftResult?.matchingNft;
          console.log(`[subscription] Pending user ${verification.telegram_user_id} now qualifies - activating!`);
          await activatePendingVerification(
            verification,
            nft?.category || '',
            nft?.commitment ?? null
          );
        }
        // If still doesn't qualify, remain pending (no action needed)
      } else {
        // Active verification - check if still qualifies
        if (!result.satisfied) {
          console.log(`[subscription] User ${verification.telegram_user_id} no longer qualifies - will restrict`);
          await handleNftTransferred(verification);
        } else if (verification.nft_category) {
          // Check if we should update the NFT tracking
          const nftResult = result.nftResults.find(r => r.satisfied && r.matchingNft);
          const newNft = nftResult?.matchingNft;

          if (newNft) {
            const currentNftStillValid = result.nftResults.some(
              r => r.satisfied && r.matchingNft &&
                r.matchingNft.category.toLowerCase() === verification.nft_category!.toLowerCase() &&
                r.matchingNft.commitment === verification.nft_commitment
            );

            if (!currentNftStillValid) {
              console.log(`[subscription] User ${verification.telegram_user_id} switching to ${newNft.category.slice(0, 8)}...`);
              updateVerificationNft(verification.id, newNft.category, newNft.commitment);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[subscription] Error checking verification ${verification.id}:`, error);
    }
  }
}

/**
 * Activate a pending verification when user acquires qualifying NFT
 */
async function activatePendingVerification(
  verification: { id: number; telegram_user_id: number; group_id: number; bch_address: string },
  nftCategory: string,
  nftCommitment: string | null
): Promise<void> {
  if (!botInstance) {
    console.error('Bot instance not available for activating pending verification');
    return;
  }

  try {
    // Update verification to active with NFT details
    updateVerificationStatus(verification.id, 'active', nftCategory, nftCommitment);

    // Remove from pending kicks
    deletePendingKick(verification.telegram_user_id, verification.group_id);

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

    console.log(`[monitor] Activated pending verification for user ${verification.telegram_user_id} in group ${verification.group_id}`);

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
  let switched = 0;
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

      if (verification.status === 'pending') {
        // Pending verification
        if (result.satisfied) {
          // Now qualifies - activate!
          const nftResult = result.nftResults.find(r => r.satisfied && r.matchingNft);
          const nft = nftResult?.matchingNft;
          await activatePendingVerification(
            verification,
            nft?.category || '',
            nft?.commitment ?? null
          );
          activated++;
        } else {
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
                  { permissions: { can_send_messages: false } }
                );
                console.log(`[monitor] Restricted pending user ${verification.telegram_user_id} in group ${verification.group_id}`);
              }
            } catch (e) {
              // Ignore errors (user may have left, bot may not have permission)
            }
          }
        }
      } else {
        // Active verification
        if (!result.satisfied) {
          invalid++;
          console.log(
            `[monitor] User ${verification.telegram_user_id} no longer qualifies - will restrict`
          );
          await handleNftTransferred(verification);
        } else {
          // Check if we should update the NFT tracking
          if (verification.nft_category) {
            const nftResult = result.nftResults.find(r => r.satisfied && r.matchingNft);
            const newNft = nftResult?.matchingNft;

            if (newNft) {
              const currentNftStillValid = result.nftResults.some(
                r => r.satisfied && r.matchingNft &&
                  r.matchingNft.category.toLowerCase() === verification.nft_category!.toLowerCase() &&
                  r.matchingNft.commitment === verification.nft_commitment
              );

              if (!currentNftStillValid) {
                console.log(
                  `[monitor] User ${verification.telegram_user_id} switching to ${newNft.category.slice(0, 8)}...${newNft.commitment || 'null'}`
                );
                updateVerificationNft(verification.id, newNft.category, newNft.commitment);
                switched++;
              }
            }
          }
          valid++;
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
  const switchedInfo = switched > 0 ? `, ${switched} switched` : '';
  const activatedInfo = activated > 0 ? `, ${activated} activated` : '';
  const pendingInfo = pending > 0 ? `, ${pending} pending` : '';
  console.log(
    `[monitor] ${userGroupMap.size} user-groups | ${valid} valid, ${invalid} invalid${switchedInfo}${activatedInfo}${pendingInfo}, ${errors} errors | groups: ${groupInfo}`
  );
}

/**
 * Handle when an NFT has been transferred away from verified address
 */
async function handleNftTransferred(verification: {
  id: number;
  telegram_user_id: number;
  group_id: number;
  nft_category: string | null;
  nft_commitment: string | null;
  bch_address: string;
}): Promise<void> {
  if (!botInstance) {
    console.error('Bot instance not available for kicking user');
    return;
  }

  try {
    // Check if user is admin/creator - don't kick them
    const member = await botInstance.api.getChatMember(
      verification.group_id,
      verification.telegram_user_id
    );

    if (member.status === 'administrator' || member.status === 'creator') {
      console.log(
        `User ${verification.telegram_user_id} is admin/creator - setting to pending, not kicking`
      );
      // Set back to pending - they can receive another NFT
      updateVerificationStatus(verification.id, 'pending');
      return;
    }

    // Set verification back to pending (keeps monitoring the address)
    updateVerificationStatus(verification.id, 'pending');

    // Restrict the user (but don't kick - they can still receive NFT and get re-activated)
    try {
      await botInstance.api.restrictChatMember(
        verification.group_id,
        verification.telegram_user_id,
        { permissions: { can_send_messages: false } }
      );
      console.log(
        `Restricted user ${verification.telegram_user_id} in group ${verification.group_id} - NFT transferred, now pending`
      );
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
    console.error(
      `Error handling NFT transfer for user ${verification.telegram_user_id}:`,
      error
    );
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

  const verification = verifications[0];

  // Pending verifications don't have an NFT yet
  if (!verification.nft_category) {
    return false;
  }

  const stillHoldsNft = await isNftAtAddress(
    verification.bch_address,
    verification.nft_category,
    verification.nft_commitment
  );

  return stillHoldsNft;
}

/**
 * Check all verifications for a specific group (e.g., after condition removal)
 */
export async function checkGroupVerifications(groupId: number): Promise<{
  checked: number;
  valid: number;
  invalid: number;
  switched: number;
}> {
  const verifications = getVerificationsForMonitoring().filter(
    v => v.group_id === groupId
  );

  const rules = getAccessRules(groupId);

  let valid = 0;
  let invalid = 0;
  let switched = 0;

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
      // If no rules left, all verifications are invalid
      if (rules.length === 0) {
        invalid++;
        await handleNftTransferred(verification);
        continue;
      }

      // Get all addresses for this user
      const userAddresses = [...new Set(userVerifications.map(v => v.bch_address))];

      // Check access rules
      const result = await checkAccessRulesMultiAddress(userAddresses, rules);

      if (!result.satisfied) {
        invalid++;
        console.log(`[monitor] Group check: user ${userId} no longer qualifies - will restrict`);
        await handleNftTransferred(verification);
      } else {
        // Check if current NFT still valid
        if (verification.nft_category) {
          const nftResult = result.nftResults.find(r => r.satisfied && r.matchingNft);
          const newNft = nftResult?.matchingNft;

          if (newNft) {
            const currentNftStillValid = result.nftResults.some(
              r => r.satisfied && r.matchingNft &&
                r.matchingNft.category.toLowerCase() === verification.nft_category!.toLowerCase() &&
                r.matchingNft.commitment === verification.nft_commitment
            );

            if (!currentNftStillValid) {
              console.log(`[monitor] Group check: user ${userId} switching to ${newNft.category.slice(0, 8)}...`);
              updateVerificationNft(verification.id, newNft.category, newNft.commitment);
              switched++;
            }
          }
        }
        valid++;
      }
    } catch (error) {
      console.error(`[monitor] Error checking verification ${verification.id}:`, error);
    }
  }

  return { checked: userMap.size, valid, invalid, switched };
}
