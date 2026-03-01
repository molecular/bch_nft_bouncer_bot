import { Context, Composer } from 'grammy';
import {
  getGroup,
  isGroupConfigured,
  getVerification,
  addPendingKick,
  getPendingKick,
  getNftCategories,
} from '../../storage/queries.js';
import { restrictUser, unrestrictUser, unrestrictIfNeeded } from '../utils/permissions.js';
import { fetchTokenMetadata, formatTokenName } from '../../blockchain/bcmr.js';

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

  // Handle joins OR status becoming restricted (might be verified user who needs unrestriction)
  const wasNotMember = ['left', 'kicked', 'banned'].includes(old_chat_member.status);
  const isNowMember = ['member', 'restricted', 'administrator', 'creator'].includes(new_chat_member.status);
  const becameRestricted = new_chat_member.status === 'restricted';

  // Process if: joining from outside, OR status changed to restricted (might need to fix verified user)
  if (!((wasNotMember && isNowMember) || becameRestricted)) {
    console.log(`[chat_member] Skipping: wasNotMember=${wasNotMember}, isNowMember=${isNowMember}, becameRestricted=${becameRestricted}`);
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

  // Check if user is already verified (active, not pending)
  const verification = getVerification(userId, chatId);
  if (verification && verification.status === 'active') {
    console.log(`User ${userId} already verified (active) for group ${chatId}, ensuring unrestricted`);
    try {
      await unrestrictUser(ctx.api, chatId, userId);
      console.log(`User ${userId} unrestricted on rejoin`);
    } catch (error: any) {
      console.error(`Failed to unrestrict verified user ${userId}:`, error.message);
    }
    return;
  }

  // If user has a pending verification, keep them restricted
  if (verification && verification.status === 'pending') {
    console.log(`User ${userId} has pending verification for group ${chatId}, staying restricted`);
    return;
  }

  // Check if we've already prompted this user (avoid duplicate prompts when restriction triggers chat_member event)
  const pending = getPendingKick(userId, chatId);
  if (pending) {
    console.log(`User ${userId} already in pending_kicks, skipping prompt`);
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
    await restrictUser(ctx.api, chatId, userId);

    // Track pending verification
    addPendingKick(userId, chatId);

    // Fetch categories and their metadata for display
    const categories = getNftCategories(chatId);
    const metadataResults = await Promise.all(categories.map(cat => fetchTokenMetadata(cat)));
    const categoryList = categories.map((cat, i) => formatTokenName(cat, metadataResults[i])).join(', ');

    // Post message in group
    await ctx.api.sendMessage(
      chatId,
      `👋 ${username} - This group requires NFT verification.\n\n` +
      `Accepted NFTs: ${categoryList}\n\n` +
      `Click to verify: ${deepLink}`
    );

    // Also try to DM (no Markdown - bot username has underscores that break links)
    try {
      await ctx.api.sendMessage(
        userId,
        `👋 Hello ${username}!\n\n` +
        `You joined "${group.name}", which requires NFT verification.\n\n` +
        `Accepted NFTs: ${categoryList}\n\n` +
        `Click here to verify:\n${deepLink}`
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
    // User is verified - but check if they're still restricted (fallback fix)
    try {
      const wasRestricted = await unrestrictIfNeeded(ctx.api, chatId, userId);
      if (wasRestricted) {
        console.log(`[join] Unrestricted verified user ${userId}`);
      }
    } catch (error: any) {
      console.error(`[join] Error unrestricting verified user ${userId}:`, error.message);
    }
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
    await restrictUser(ctx.api, chatId, userId);

    // Track pending verification
    addPendingKick(userId, chatId);

    // Fetch categories and their metadata for display
    const categories = getNftCategories(chatId);
    const metadataResults = await Promise.all(categories.map(cat => fetchTokenMetadata(cat)));
    const categoryList = categories.map((cat, i) => formatTokenName(cat, metadataResults[i])).join(', ');

    // Notify in group
    await ctx.api.sendMessage(
      chatId,
      `⚠️ ${username} - You must verify NFT ownership before posting.\n\n` +
      `Accepted NFTs: ${categoryList}\n\n` +
      `Click to verify: ${deepLink}`
    );

  } catch (error: any) {
    console.error(`Error handling unverified message from ${userId}:`, error.message);
  }
});

// Note: new_chat_members handler removed - using chat_member updates instead
