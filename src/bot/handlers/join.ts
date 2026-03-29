import { Context, Composer } from 'grammy';
import {
  getGroup,
  getVerificationsForUser,
  addGroupMembership,
  getGroupMembership,
  setMembershipStatus,
  getNftCategories,
  updateMembershipMessageId,
  getAccessRules,
} from '../../storage/queries.js';
import { restrictUser, unrestrictUser, unrestrictIfNeeded } from '../utils/permissions.js';
import { fetchTokenMetadata, formatTokenName } from '../../blockchain/bcmr.js';
import { checkAccessRulesMultiAddress } from '../../blockchain/nft.js';
import { log, trackUser } from '../../utils/log.js';

export const joinHandlers = new Composer();

// Handle new chat members
joinHandlers.on('chat_member', async (ctx: Context) => {
  log('chat_member', 'Event received');
  const update = ctx.chatMember;
  if (!update) {
    log('chat_member', 'No update data');
    return;
  }

  const { chat, new_chat_member, old_chat_member } = update;

  // Track user info
  trackUser(new_chat_member.user.id, new_chat_member.user.username, new_chat_member.user.first_name);

  log('chat_member', `${old_chat_member.status} -> ${new_chat_member.status}`, new_chat_member.user.id, { groupId: chat.id });

  // Handle joins OR status becoming restricted (might be verified user who needs unrestriction)
  const wasNotMember = ['left', 'kicked', 'banned'].includes(old_chat_member.status);
  const isNowMember = ['member', 'restricted', 'administrator', 'creator'].includes(new_chat_member.status);
  const becameRestricted = new_chat_member.status === 'restricted';

  // Process if: joining from outside, OR status changed to restricted (might need to fix verified user)
  if (!((wasNotMember && isNowMember) || becameRestricted)) {
    log('chat_member', `Skipping: wasNotMember=${wasNotMember}, isNowMember=${isNowMember}, becameRestricted=${becameRestricted}`, new_chat_member.user.id);
    return;
  }

  const userId = new_chat_member.user.id;
  const chatId = chat.id;

  // Ignore bot's own join
  if (userId === ctx.me.id) {
    return;
  }

  // Check if user is admin/owner (they're exempt from restrictions but we still track them)
  const isAdmin = new_chat_member.status === 'administrator' || new_chat_member.status === 'creator';

  // Check if this group is managed by the bot
  const group = getGroup(chatId);
  if (!group) {
    return; // Bot not managing this group
  }

  // Check existing membership and verifications
  const membership = getGroupMembership(userId, chatId);
  const verifications = getVerificationsForUser(userId);
  const userAddresses = [...new Set(verifications.map(v => v.bch_address))];
  const rules = getAccessRules(chatId);

  if (membership?.status === 'authorized') {
    // User is already authorized - ensure unrestricted (skip for admins)
    if (!isAdmin) {
      log('join', 'authorized, ensuring unrestricted', userId, { groupId: chatId });
      try {
        await unrestrictUser(ctx.api, chatId, userId);
        log('join', 'unrestricted on rejoin', userId, { groupId: chatId });
      } catch (error: any) {
        log('join', `failed to unrestrict: ${error.message}`, userId, { groupId: chatId });
      }
    }
    return;
  }

  // If no rules configured, everyone qualifies
  if (rules.length === 0) {
    log('join', 'no rules - auto-authorized', userId, { groupId: chatId });
    addGroupMembership(userId, chatId, 'authorized');
    return;
  }

  // Check if user has verifications and qualifies
  if (verifications.length > 0) {
    const result = await checkAccessRulesMultiAddress(userAddresses, rules);
    if (result.satisfied) {
      // User qualifies - add as authorized and unrestrict (skip unrestrict for admins)
      log('join', 'verifications qualify, granting access', userId, { groupId: chatId });
      addGroupMembership(userId, chatId, 'authorized');
      if (!isAdmin) {
        try {
          await unrestrictUser(ctx.api, chatId, userId);
        } catch (error: any) {
          log('join', `failed to unrestrict qualifying user: ${error.message}`, userId, { groupId: chatId });
        }
      }
      return;
    }
  }

  // Check if we've already tracked this user (avoid duplicate prompts)
  if (membership) {
    log('join', `already has membership (status: ${membership.status}), skipping prompt`, userId, { groupId: chatId });
    return;
  }

  // Admins get tracked as authorized without needing to verify
  if (isAdmin) {
    log('join', 'admin joined, tracking as authorized', userId, { groupId: chatId });
    addGroupMembership(userId, chatId, 'authorized');
    return;
  }

  // New user who doesn't qualify - restrict until verified
  log('join', 'new user joined, restricting...', userId, { groupId: chatId });

  const username = new_chat_member.user.username
    ? `@${new_chat_member.user.username}`
    : new_chat_member.user.first_name;

  const botUsername = ctx.me.username;
  const deepLink = `https://t.me/${botUsername}?start=verify_${chatId}`;

  try {
    // Restrict user - they can read but not post until verified
    await restrictUser(ctx.api, chatId, userId);

    // Track membership as restricted
    addGroupMembership(userId, chatId, 'restricted');

    // Fetch categories and their metadata for display
    const categories = getNftCategories(chatId);
    const metadataResults = await Promise.all(categories.map(cat => fetchTokenMetadata(cat)));
    const categoryList = categories.map((cat, i) => formatTokenName(cat, metadataResults[i])).join(', ');

    // Post message in group and store the message ID
    const promptMessage = await ctx.api.sendMessage(
      chatId,
      `👋 ${username} - This group requires wallet verification.\n\n` +
      `Requirements: ${categoryList}\n\n` +
      `Click to verify: ${deepLink}`
    );
    updateMembershipMessageId(userId, chatId, promptMessage.message_id);

    // Also try to DM (no Markdown - bot username has underscores that break links)
    try {
      await ctx.api.sendMessage(
        userId,
        `👋 Hello ${username}!\n\n` +
        `You joined "${group.name}", which requires wallet verification.\n\n` +
        `Requirements: ${categoryList}\n\n` +
        `Click here to verify:\n${deepLink}`
      );
    } catch (dmError: any) {
      log('join', `could not DM: ${dmError.message}`, userId, { groupId: chatId });
    }

  } catch (error: any) {
    log('join', `error handling join: ${error.message}`, userId, { groupId: chatId });

    if (error.message?.includes('not enough rights')) {
      log('join', 'bot does not have permission to restrict users');
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

  if (!userId) return next();

  // Track user if we have info
  if (ctx.from) {
    trackUser(userId, ctx.from.username, ctx.from.first_name);
  }

  log('join', `message in group: "${text.slice(0, 20)}..."`, userId, { groupId: chatId });

  // Skip command messages - let command handlers process them
  if (text.startsWith('/')) {
    log('join', 'skipping command message', userId);
    return next();
  }

  // Check if this group is managed by the bot
  const group = getGroup(chatId);
  if (!group) {
    return next(); // Bot not managing this group
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

  // Check existing membership and verifications
  const membership = getGroupMembership(userId, chatId);
  const verifications = getVerificationsForUser(userId);
  const userAddresses = [...new Set(verifications.map(v => v.bch_address))];
  const rules = getAccessRules(chatId);

  // If user is authorized, allow message
  if (membership?.status === 'authorized') {
    // Ensure unrestricted (in case they got restricted externally)
    try {
      const wasRestricted = await unrestrictIfNeeded(ctx.api, chatId, userId);
      if (wasRestricted) {
        log('join', 'unrestricted authorized user', userId, { groupId: chatId });
      }
    } catch (error: any) {
      log('join', `error unrestricting authorized user: ${error.message}`, userId, { groupId: chatId });
    }
    return next();
  }

  // If no rules configured, everyone qualifies
  if (rules.length === 0) {
    if (!membership) {
      log('join', 'no rules - auto-authorized', userId, { groupId: chatId });
      addGroupMembership(userId, chatId, 'authorized');
    }
    return next();
  }

  // Check if user has no membership record but has verifications
  if (!membership && verifications.length > 0) {
    const result = await checkAccessRulesMultiAddress(userAddresses, rules);
    if (result.satisfied) {
      // User qualifies - add as authorized and allow
      log('join', 'qualifies via existing verifications', userId, { groupId: chatId });
      addGroupMembership(userId, chatId, 'authorized');
      try {
        await unrestrictIfNeeded(ctx.api, chatId, userId);
      } catch (error: any) {
        log('join', `error unrestricting: ${error.message}`, userId, { groupId: chatId });
      }
      return next();
    }
  }

  // User is restricted or doesn't qualify
  if (membership?.status === 'restricted') {
    // User is restricted and knows it - just delete message quietly
    try {
      await ctx.api.deleteMessage(chatId, ctx.message!.message_id);
    } catch {
      // Ignore delete errors
    }
    return; // Don't spam them - they already know
  }

  // First time seeing this user - they need verification
  log('join', 'unverified user posted in gated group, deleting message', userId, { groupId: chatId });

  try {
    // Delete the message
    await ctx.api.deleteMessage(chatId, ctx.message!.message_id);

    const username = ctx.from?.username
      ? `@${ctx.from.username}`
      : ctx.from?.first_name || 'User';

    const botUsername = ctx.me.username;
    const deepLink = `https://t.me/${botUsername}?start=verify_${chatId}`;

    // Restrict user (in case they weren't already)
    await restrictUser(ctx.api, chatId, userId);

    // Track membership as restricted
    addGroupMembership(userId, chatId, 'restricted');

    // Fetch categories and their metadata for display
    const categories = getNftCategories(chatId);
    const metadataResults = await Promise.all(categories.map(cat => fetchTokenMetadata(cat)));
    const categoryList = categories.map((cat, i) => formatTokenName(cat, metadataResults[i])).join(', ');

    // Notify in group and store the message ID
    const promptMessage = await ctx.api.sendMessage(
      chatId,
      `⚠️ ${username} - You must verify your wallet meets the access requirements.\n\n` +
      `Requirements: ${categoryList}\n\n` +
      `Click to verify: ${deepLink}`
    );
    updateMembershipMessageId(userId, chatId, promptMessage.message_id);

  } catch (error: any) {
    log('join', `error handling unverified message: ${error.message}`, userId, { groupId: chatId });
  }
});

// Note: new_chat_members handler removed - using chat_member updates instead
