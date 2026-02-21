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

  // New unverified user - notify then kick
  console.log(`New unverified user ${userId} joined group ${chatId}, kicking...`);

  const username = new_chat_member.user.username
    ? `@${new_chat_member.user.username}`
    : new_chat_member.user.first_name;

  const botUsername = ctx.me.username;
  const deepLink = `https://t.me/${botUsername}?start=verify_${chatId}`;

  try {
    // Restrict user - they can read but not post until verified
    await ctx.api.restrictChatMember(chatId, userId, {
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_invite_users: false,
      },
    });

    // Track pending verification
    addPendingKick(userId, chatId);

    // Post message in group
    await ctx.api.sendMessage(
      chatId,
      `👋 ${username} - This group requires NFT verification.\n\n` +
      `You can read messages but cannot post until verified.\n\n` +
      `Click to verify: ${deepLink}`
    );

    // Also try to DM
    try {
      await ctx.api.sendMessage(
        userId,
        `👋 Hello ${username}!\n\n` +
        `You joined **${group.name}**, which requires NFT verification.\n\n` +
        `You can read messages but cannot post until verified.\n\n` +
        `Click here to verify:\n${deepLink}`,
        { parse_mode: 'Markdown' }
      );
    } catch (dmError: any) {
      console.log(`Could not DM user ${userId}:`, dmError.message);
    }

  } catch (error: any) {
    console.error(`Error handling join for user ${userId}:`, error.message);

    if (error.message?.includes('not enough rights')) {
      console.error('Bot does not have permission to restrict users');
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

    const botUsername = ctx.me.username;
    const deepLink = `https://t.me/${botUsername}?start=verify_${chatId}`;
    const username = member.username ? `@${member.username}` : member.first_name;

    try {
      // Restrict user - they can read but not post until verified
      await ctx.api.restrictChatMember(chatId, userId, {
        permissions: {
          can_send_messages: false,
          can_send_audios: false,
          can_send_documents: false,
          can_send_photos: false,
          can_send_videos: false,
          can_send_video_notes: false,
          can_send_voice_notes: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
          can_invite_users: false,
        },
      });

      // Track pending verification
      addPendingKick(userId, chatId);

      // Post message in group
      await ctx.api.sendMessage(
        chatId,
        `👋 ${username} - This group requires NFT verification.\n\n` +
        `You can read messages but cannot post until verified.\n\n` +
        `Click to verify: ${deepLink}`
      );

      // Also try to DM
      try {
        await ctx.api.sendMessage(
          userId,
          `👋 Hello!\n\n` +
          `You joined **${group.name}**, which requires NFT verification.\n\n` +
          `You can read messages but cannot post until verified.\n\n` +
          `Click here to verify:\n${deepLink}`,
          { parse_mode: 'Markdown' }
        );
      } catch (dmError) {
        console.log(`Could not DM user ${userId}`);
      }

    } catch (error: any) {
      console.error(`Error restricting user ${userId}:`, error.message);
    }
  }
});
