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
  console.log('[chat_member] Event received');
  const update = ctx.chatMember;
  if (!update) {
    console.log('[chat_member] No update data');
    return;
  }

  const { chat, new_chat_member, old_chat_member } = update;

  console.log(`[chat_member] User ${new_chat_member.user.id}: ${old_chat_member.status} -> ${new_chat_member.status}`);

  // Only handle joins (status change to 'member' or 'restricted')
  const wasNotMember = ['left', 'kicked', 'banned'].includes(old_chat_member.status);
  const isNowMember = ['member', 'restricted', 'administrator', 'creator'].includes(new_chat_member.status);

  if (!wasNotMember || !isNowMember) {
    console.log(`[chat_member] Skipping: wasNotMember=${wasNotMember}, isNowMember=${isNowMember}`);
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
    console.log(`User ${userId} already verified for group ${chatId}, ensuring unrestricted`);
    // Make sure they're unrestricted (in case previous unrestriction failed)
    try {
      await ctx.api.restrictChatMember(chatId, userId, {
        permissions: {
          can_send_messages: true,
          can_send_audios: true,
          can_send_documents: true,
          can_send_photos: true,
          can_send_videos: true,
          can_send_video_notes: true,
          can_send_voice_notes: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
          can_change_info: true,
          can_invite_users: true,
          can_pin_messages: true,
          can_manage_topics: true,
        },
      });
      console.log(`User ${userId} unrestricted on rejoin`);
    } catch (error: any) {
      console.error(`Failed to unrestrict verified user ${userId}:`, error.message);
    }
    return;
  }

  // New unverified user - restrict until verified
  console.log(`New unverified user ${userId} joined group ${chatId}, restricting...`);

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

// Catch unverified users trying to post in gated groups
// This handles cases where the join event was missed (user was already in group, bot was offline, etc.)
joinHandlers.on('message', async (ctx: Context, next) => {
  // Only handle group messages
  if (!ctx.chat || ctx.chat.type === 'private') {
    return next();
  }

  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  const text = (ctx.message as any)?.text || '';

  console.log(`[join] message handler: user=${userId}, chat=${chatId}, text="${text.slice(0, 20)}..."`);

  if (!userId) return next();

  // Skip command messages - let command handlers process them
  if (text.startsWith('/')) {
    console.log(`[join] skipping command message`);
    return next();
  }

  // Check if this group is configured for NFT gating
  const group = getGroup(chatId);
  if (!group || !isGroupConfigured(chatId)) {
    return next(); // Not a gated group
  }

  // Check if user is admin/creator (they're exempt)
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    if (member.status === 'administrator' || member.status === 'creator') {
      return next();
    }
  } catch (error) {
    // If we can't check membership, continue with verification check
  }

  // Check if user is verified
  const verification = getVerification(userId, chatId);
  if (verification) {
    return next(); // User is verified, allow message
  }

  // Unverified user posted - delete message and remind them
  console.log(`Unverified user ${userId} posted in gated group ${chatId}, deleting message`);

  const username = ctx.from?.username
    ? `@${ctx.from.username}`
    : ctx.from?.first_name || 'User';

  const botUsername = ctx.me.username;
  const deepLink = `https://t.me/${botUsername}?start=verify_${chatId}`;

  try {
    // Delete the message
    await ctx.api.deleteMessage(chatId, ctx.message!.message_id);

    // Restrict user (in case they weren't already)
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

    // Notify in group
    await ctx.api.sendMessage(
      chatId,
      `⚠️ ${username} - You must verify NFT ownership before posting.\n\n` +
      `Click to verify: ${deepLink}`
    );

  } catch (error: any) {
    console.error(`Error handling unverified message from ${userId}:`, error.message);
  }
});

// Note: new_chat_members handler removed - using chat_member updates instead
