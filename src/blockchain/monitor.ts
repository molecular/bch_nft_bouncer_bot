import { getProvider } from './wallet.js';
import { isNftAtAddress } from './nft.js';
import { getVerificationsForMonitoring, deleteVerification } from '../storage/queries.js';
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
 * Check all verifications and kick users who no longer hold their NFT
 */
async function checkAllVerifications(): Promise<void> {
  const verifications = getVerificationsForMonitoring();

  if (verifications.length === 0) {
    return;
  }

  console.log(`Checking ${verifications.length} verifications...`);

  for (const verification of verifications) {
    try {
      const stillHoldsNft = await isNftAtAddress(
        verification.bch_address,
        verification.nft_category,
        verification.nft_commitment
      );

      if (!stillHoldsNft) {
        console.log(
          `NFT no longer at address ${verification.bch_address} for user ${verification.telegram_user_id}`
        );

        await handleNftTransferred(verification);
      }
    } catch (error) {
      console.error(
        `Error checking verification ${verification.id}:`,
        error
      );
    }
  }
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
    // Try to kick the user from the group
    await botInstance.api.banChatMember(
      verification.group_id,
      verification.telegram_user_id
    );

    // Immediately unban so they can rejoin after re-verifying
    await botInstance.api.unbanChatMember(
      verification.group_id,
      verification.telegram_user_id
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
