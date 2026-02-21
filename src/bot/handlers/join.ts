import { Context, Composer } from 'grammy';
import {
  getGroup,
  isGroupConfigured,
  getVerification,
  addPendingKick,
} from '../../storage/queries.js';

export const joinHandlers = new Composer();

// Handle new chat members
joinHandlers.on('chat_member', async (ctx: Context) => {
  const update = ctx.chatMember;
  if (!update) return;

  const { chat, new_chat_member, old_chat_member } = update;

  // Only handle joins (status change to 'member' or 'restricted')
  const wasNotMember = ['left', 'kicked', 'banned'].includes(old_chat_member.status);
  const isNowMember = ['member', 'restricted', 'administrator', 'creator'].includes(new_chat_member.status);

  if (!wasNotMember || !isNowMember) {
    return;
  }

  const userId = new_chat_member.user.id;
  const chatId = chat.id;

  // Ignore bot's own join
  if (userId === ctx.me.id) {
    return;
  }

  // Ignore admins/owners
  if (new_chat_member.status === 'administrator' || new_chat_member.status === 'creator') {
    return;
  }

  // Check if this group is configured
  const group = getGroup(chatId);
  if (!group || !isGroupConfigured(chatId)) {
    return; // Not a gated group
  }

  // Check if user is already verified
  const verification = getVerification(userId, chatId);
  if (verification) {
    console.log(`User ${userId} already verified for group ${chatId}`);
    return; // Already verified, allow access
  }

  // New unverified user - kick and send DM
  console.log(`New unverified user ${userId} joined group ${chatId}, kicking...`);

  try {
    // Kick the user (ban then unban to allow rejoin)
    await ctx.api.banChatMember(chatId, userId);
    await ctx.api.unbanChatMember(chatId, userId);

    // Track pending kick
    addPendingKick(userId, chatId);

    // Send DM with verification instructions
    const username = new_chat_member.user.username
      ? `@${new_chat_member.user.username}`
      : new_chat_member.user.first_name;

    try {
      const botUsername = ctx.me.username;
      const deepLink = `https://t.me/${botUsername}?start=verify_${chatId}`;

      await ctx.api.sendMessage(
        userId,
        `👋 Hello ${username}!\n\n` +
        `You tried to join **${group.name}**, which requires NFT verification.\n\n` +
        `To join, you must prove you own a qualifying CashToken NFT.\n\n` +
        `Click here to start verification:\n${deepLink}\n\n` +
        `Or use /verify in this chat.`,
        { parse_mode: 'Markdown' }
      );
    } catch (dmError: any) {
      // User may have blocked the bot or never started a conversation
      console.log(`Could not DM user ${userId}:`, dmError.message);

      // Try to send a message in the group (will be visible briefly before kick)
      // This is a fallback - the kick happens too fast usually
    }

  } catch (error: any) {
    console.error(`Error handling join for user ${userId}:`, error.message);

    // Check if it's a permission error
    if (error.message?.includes('not enough rights')) {
      console.error('Bot does not have permission to kick users');
    }
  }
});

// Also handle the simpler new_chat_members event for groups that don't send chat_member updates
joinHandlers.on('message:new_chat_members', async (ctx: Context) => {
  const newMembers = ctx.message?.new_chat_members;
  if (!newMembers) return;

  const chatId = ctx.chat!.id;

  // Check if this group is configured
  const group = getGroup(chatId);
  if (!group || !isGroupConfigured(chatId)) {
    return;
  }

  for (const member of newMembers) {
    // Ignore bots
    if (member.is_bot) continue;

    // Ignore the bot itself
    if (member.id === ctx.me.id) continue;

    const userId = member.id;

    // Check if user is already verified
    const verification = getVerification(userId, chatId);
    if (verification) {
      continue; // Already verified
    }

    console.log(`New unverified user ${userId} (via new_chat_members) in group ${chatId}`);

    try {
      // Kick the user
      await ctx.api.banChatMember(chatId, userId);
      await ctx.api.unbanChatMember(chatId, userId);

      // Track pending kick
      addPendingKick(userId, chatId);

      // Send DM
      try {
        const botUsername = ctx.me.username;
        const deepLink = `https://t.me/${botUsername}?start=verify_${chatId}`;

        await ctx.api.sendMessage(
          userId,
          `👋 Hello!\n\n` +
          `You tried to join **${group.name}**, which requires NFT verification.\n\n` +
          `To join, you must prove you own a qualifying CashToken NFT.\n\n` +
          `Click here to start verification:\n${deepLink}`,
          { parse_mode: 'Markdown' }
        );
      } catch (dmError) {
        console.log(`Could not DM user ${userId}`);
      }

    } catch (error: any) {
      console.error(`Error kicking user ${userId}:`, error.message);
    }
  }
});
