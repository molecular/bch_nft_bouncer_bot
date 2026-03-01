import { getProvider } from './wallet.js';
import { isNftAtAddress, checkNftOwnership } from './nft.js';
import { getVerificationsForMonitoring, deleteVerification, updateVerificationNft, updateVerificationStatus, getNftCategories, getGroup, getAllVerifiedAddresses, getPendingVerificationsByAddress, deletePendingKick } from '../storage/queries.js';
import { unrestrictUser } from '../bot/utils/permissions.js';
import type { Bot } from 'grammy';

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
      const categories = getNftCategories(verification.group_id);
      const ownedNfts = await checkNftOwnership(verification.bch_address, categories);

      if (verification.status === 'pending') {
        // Pending verification - check if now qualifies
        if (ownedNfts.length > 0) {
          const nft = ownedNfts[0];
          console.log(`[subscription] Pending user ${verification.telegram_user_id} now has NFT - activating!`);
          await activatePendingVerification(verification, nft.category, nft.commitment);
        }
        // If still no NFT, remain pending (no action needed)
      } else {
        // Active verification - check if still qualifies
        if (ownedNfts.length === 0) {
          console.log(`[subscription] User ${verification.telegram_user_id} lost all qualifying NFTs - will kick`);
          await handleNftTransferred(verification);
        } else if (verification.nft_category) {
          const currentNftStillValid = ownedNfts.some(
            nft => nft.category.toLowerCase() === verification.nft_category!.toLowerCase() &&
                   nft.commitment === verification.nft_commitment
          );

          if (!currentNftStillValid) {
            const newNft = ownedNfts[0];
            console.log(`[subscription] User ${verification.telegram_user_id} switching to ${newNft.category.slice(0, 8)}...`);
            updateVerificationNft(verification.id, newNft.category, newNft.commitment);
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
      const groupName = group?.name || `Group ${verification.group_id}`;

      // Try to get a link to the group
      let groupLink = '';
      try {
        const chat = await botInstance.api.getChat(verification.group_id);
        if ('username' in chat && chat.username) {
          groupLink = `\n\nGo to group: https://t.me/${chat.username}`;
        } else if ('invite_link' in chat && chat.invite_link) {
          groupLink = `\n\nGo to group: ${chat.invite_link}`;
        }
      } catch {
        // Ignore errors getting chat info
      }

      await botInstance.api.sendMessage(
        verification.telegram_user_id,
        `🎉 **Great news!**\n\n` +
        `Your address received a qualifying NFT!\n\n` +
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
 * Check all verifications and kick users who no longer hold ANY qualifying NFT
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

  for (const verification of verifications) {
    // Count by group
    groupCounts.set(verification.group_id, (groupCounts.get(verification.group_id) || 0) + 1);

    try {
      // Get all qualifying categories for this group
      const categories = getNftCategories(verification.group_id);

      // Check if user holds ANY qualifying NFT
      const ownedNfts = await checkNftOwnership(verification.bch_address, categories);

      if (verification.status === 'pending') {
        // Pending verification
        if (ownedNfts.length > 0) {
          // Now has NFT - activate!
          const nft = ownedNfts[0];
          await activatePendingVerification(verification, nft.category, nft.commitment);
          activated++;
        } else {
          // Still no NFT
          pending++;
        }
      } else {
        // Active verification
        if (ownedNfts.length === 0) {
          invalid++;
          console.log(
            `[monitor] User ${verification.telegram_user_id} has no qualifying NFTs - will kick`
          );

          await handleNftTransferred(verification);
        } else {
          // Check if we need to switch to a different NFT
          if (verification.nft_category) {
            const currentNftStillValid = ownedNfts.some(
              nft => nft.category.toLowerCase() === verification.nft_category!.toLowerCase() &&
                     nft.commitment === verification.nft_commitment
            );

            if (!currentNftStillValid) {
              // Original NFT is gone, but user has another qualifying NFT - auto-switch
              const newNft = ownedNfts[0];
              console.log(
                `[monitor] User ${verification.telegram_user_id} switching to ${newNft.category.slice(0, 8)}...${newNft.commitment || 'null'}`
              );
              updateVerificationNft(verification.id, newNft.category, newNft.commitment);
              switched++;
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
    `[monitor] ${verifications.length} users | ${valid} valid, ${invalid} invalid${switchedInfo}${activatedInfo}${pendingInfo}, ${errors} errors | groups: ${groupInfo}`
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
      const groupName = group?.name || `Group ${verification.group_id}`;
      await botInstance.api.sendMessage(
        verification.telegram_user_id,
        `⚠️ Your NFT was transferred out of your verified address.\n\n` +
        `You've been restricted in **${groupName}** until you receive another qualifying NFT.\n\n` +
        `I'm still monitoring your address - you'll be automatically re-activated when you receive one!`,
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
 * Check all verifications for a specific group (e.g., after category removal)
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

  let valid = 0;
  let invalid = 0;
  let switched = 0;

  for (const verification of verifications) {
    try {
      const categories = getNftCategories(verification.group_id);

      // If no categories left, all verifications are invalid
      if (categories.length === 0) {
        invalid++;
        await handleNftTransferred(verification);
        continue;
      }

      const ownedNfts = await checkNftOwnership(verification.bch_address, categories);

      if (ownedNfts.length === 0) {
        invalid++;
        console.log(`[monitor] Group check: user ${verification.telegram_user_id} has no qualifying NFTs - will kick`);
        await handleNftTransferred(verification);
      } else {
        // Check if current NFT still valid (only for active verifications with an NFT)
        const currentNftStillValid = verification.nft_category && ownedNfts.some(
          nft => nft.category.toLowerCase() === verification.nft_category!.toLowerCase() &&
                 nft.commitment === verification.nft_commitment
        );

        if (!currentNftStillValid) {
          const newNft = ownedNfts[0];
          console.log(`[monitor] Group check: user ${verification.telegram_user_id} switching to ${newNft.category.slice(0, 8)}...`);
          updateVerificationNft(verification.id, newNft.category, newNft.commitment);
          switched++;
        }
        valid++;
      }
    } catch (error) {
      console.error(`[monitor] Error checking verification ${verification.id}:`, error);
    }
  }

  return { checked: verifications.length, valid, invalid, switched };
}
