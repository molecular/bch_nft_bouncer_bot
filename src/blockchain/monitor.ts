import { getProvider } from './wallet.js';
import { isNftAtAddress, checkNftOwnership } from './nft.js';
import { getVerificationsForMonitoring, deleteVerification, updateVerificationNft, getNftCategories, getGroup } from '../storage/queries.js';
import type { Bot } from 'grammy';

let monitoringInterval: ReturnType<typeof setInterval> | null = null;
let botInstance: Bot | null = null;

const MONITOR_INTERVAL_MS = 60_000; // Check every minute

/**
 * Start monitoring verified addresses for NFT transfers
 */
export function startMonitoring(bot: Bot): void {
  if (monitoringInterval) {
    console.log('Monitoring already running');
    return;
  }

  botInstance = bot;

  console.log('Starting NFT transfer monitoring...');

  // Run immediately on start
  checkAllVerifications();

  // Then run periodically
  monitoringInterval = setInterval(checkAllVerifications, MONITOR_INTERVAL_MS);
}

/**
 * Stop monitoring
 */
export function stopMonitoring(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  botInstance = null;
  console.log('NFT monitoring stopped');
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
  let errors = 0;
  const groupCounts = new Map<number, number>();

  for (const verification of verifications) {
    // Count by group
    groupCounts.set(verification.group_id, (groupCounts.get(verification.group_id) || 0) + 1);

    try {
      // Get all qualifying categories for this group
      const categories = getNftCategories(verification.group_id);

      console.log(`[monitor] Checking user ${verification.telegram_user_id}, address: ${verification.bch_address.slice(0, 30)}..., categories: ${categories.length}`);

      // Check if user still holds ANY qualifying NFT (not just the original one)
      const ownedNfts = await checkNftOwnership(verification.bch_address, categories);

      console.log(`[monitor] Found ${ownedNfts.length} NFTs for user ${verification.telegram_user_id}: ${JSON.stringify(ownedNfts.map(n => n.category.slice(0, 8) + '...' + (n.commitment || 'null')))}`);

      if (ownedNfts.length === 0) {
        invalid++;
        console.log(
          `[monitor] NO qualifying NFTs at address ${verification.bch_address} for user ${verification.telegram_user_id} - will kick`
        );

        await handleNftTransferred(verification);
      } else {
        // Check if we need to switch to a different NFT
        const currentNftStillValid = ownedNfts.some(
          nft => nft.category.toLowerCase() === verification.nft_category.toLowerCase() &&
                 nft.commitment === verification.nft_commitment
        );

        if (!currentNftStillValid) {
          // Original NFT is gone, but user has another qualifying NFT - auto-switch
          const newNft = ownedNfts[0];
          console.log(
            `[monitor] User ${verification.telegram_user_id} original NFT gone, switching to ${newNft.category.slice(0, 8)}...${newNft.commitment || 'null'}`
          );
          updateVerificationNft(verification.id, newNft.category, newNft.commitment);
          switched++;
        }
        valid++;
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
  console.log(
    `[monitor] ${verifications.length} users | ${valid} valid, ${invalid} invalid${switchedInfo}, ${errors} errors | groups: ${groupInfo}`
  );
}

/**
 * Handle when an NFT has been transferred away from verified address
 */
async function handleNftTransferred(verification: {
  id: number;
  telegram_user_id: number;
  group_id: number;
  nft_category: string;
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
        `User ${verification.telegram_user_id} is admin/creator - not kicking, but removing verification`
      );
      // Still remove verification record so they'd need to re-verify if demoted
      deleteVerification(verification.id);
      return;
    }

    // Kick the user with short ban (auto-unbans after 35 seconds)
    await botInstance.api.banChatMember(
      verification.group_id,
      verification.telegram_user_id,
      { until_date: Math.floor(Date.now() / 1000) + 35 }
    );

    console.log(
      `Kicked user ${verification.telegram_user_id} from group ${verification.group_id} - NFT transferred`
    );

    // Try to notify the user
    try {
      await botInstance.api.sendMessage(
        verification.telegram_user_id,
        `You have been removed from the group because your verified NFT was transferred.\n\n` +
        `If you still own a qualifying NFT, you can rejoin and verify again.`
      );
    } catch (dmError) {
      // User may have blocked the bot or never started a conversation
      console.log('Could not DM user about removal:', dmError);
    }

  } catch (error) {
    console.error(
      `Error kicking user ${verification.telegram_user_id}:`,
      error
    );
  }

  // Remove the verification record
  deleteVerification(verification.id);
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

  const stillHoldsNft = await isNftAtAddress(
    verification.bch_address,
    verification.nft_category,
    verification.nft_commitment
  );

  return stillHoldsNft;
}
