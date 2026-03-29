import type { Bot } from 'grammy';
import { config } from '../config.js';
import {
  getExpiredMemberships,
  getMembershipsToWarn,
  markMembershipWarned,
  deleteGroupMembership,
} from '../storage/queries.js';
import { log } from '../utils/log.js';

export async function checkMembershipTimeouts(bot: Bot): Promise<void> {
  const { pendingVerificationTimeoutMinutes, pendingVerificationWarnMinutes } = config;

  // 1. Send warnings
  const toWarn = getMembershipsToWarn(pendingVerificationWarnMinutes, pendingVerificationTimeoutMinutes);
  for (const pk of toWarn) {
    try {
      const minsLeft = pendingVerificationTimeoutMinutes - pendingVerificationWarnMinutes;
      const groupName = pk.group_name || 'the group';
      await bot.api.sendMessage(
        pk.telegram_user_id,
        `\u26a0\ufe0f You have ${minsLeft} minutes to verify for ${groupName} or you'll be removed. Use /verify to complete verification.`
      );
      markMembershipWarned(pk.telegram_user_id, pk.group_id);
      log('timeout', 'sent verification warning', pk.telegram_user_id, { groupId: pk.group_id });
    } catch (err) {
      // User may have blocked the bot or never started a DM
      log('timeout', `failed to warn: ${err}`, pk.telegram_user_id, { groupId: pk.group_id });
    }
  }

  // 2. Kick expired users
  const expired = getExpiredMemberships(pendingVerificationTimeoutMinutes);
  for (const pk of expired) {
    try {
      // Ban then unban = kick but allow rejoin
      await bot.api.banChatMember(pk.group_id, pk.telegram_user_id);
      await bot.api.unbanChatMember(pk.group_id, pk.telegram_user_id);

      // Clean up prompt message if exists
      if (pk.prompt_message_id) {
        try {
          await bot.api.deleteMessage(pk.group_id, pk.prompt_message_id);
        } catch {
          // Message may already be deleted
        }
      }

      // Delete membership record
      deleteGroupMembership(pk.telegram_user_id, pk.group_id);

      // Notify user via DM
      const groupName = pk.group_name || 'the group';
      try {
        await bot.api.sendMessage(
          pk.telegram_user_id,
          `You were removed from ${groupName} for not completing verification in time. You can rejoin and try again.`
        );
      } catch {
        // User may have blocked the bot
      }

      log('timeout', 'kicked expired user', pk.telegram_user_id, { groupId: pk.group_id });
    } catch (err) {
      log('timeout', `failed to kick: ${err}`, pk.telegram_user_id, { groupId: pk.group_id });
    }
  }
}
