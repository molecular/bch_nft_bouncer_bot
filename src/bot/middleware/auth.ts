import { Context, NextFunction } from 'grammy';
import { config } from '../../config.js';

/**
 * Middleware to check if user is a bot admin (from env config)
 */
export async function requireBotAdmin(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;

  if (!userId || !config.adminUserIds.includes(userId)) {
    await ctx.reply('This command is only available to bot administrators.');
    return;
  }

  await next();
}

/**
 * Middleware to check if user is a group admin
 */
export async function requireGroupAdmin(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) {
    await ctx.reply('Could not determine user or chat.');
    return;
  }

  // In private chats, check if user is bot admin
  if (ctx.chat?.type === 'private') {
    if (!config.adminUserIds.includes(userId)) {
      await ctx.reply('This command requires admin privileges.');
      return;
    }
    await next();
    return;
  }

  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    const isAdmin = member.status === 'administrator' || member.status === 'creator';

    if (!isAdmin) {
      await ctx.reply('This command is only available to group administrators.');
      return;
    }

    await next();
  } catch (error) {
    console.error('Error checking admin status:', error);
    await ctx.reply('Could not verify admin status.');
  }
}

/**
 * Check if the bot has necessary permissions in a group
 */
export async function checkBotPermissions(ctx: Context): Promise<{
  canKick: boolean;
  canInvite: boolean;
  canRestrict: boolean;
}> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return { canKick: false, canInvite: false, canRestrict: false };
  }

  try {
    const botMember = await ctx.api.getChatMember(chatId, ctx.me.id);

    if (botMember.status !== 'administrator') {
      return { canKick: false, canInvite: false, canRestrict: false };
    }

    return {
      canKick: botMember.can_restrict_members ?? false,
      canInvite: botMember.can_invite_users ?? false,
      canRestrict: botMember.can_restrict_members ?? false,
    };
  } catch (error) {
    console.error('Error checking bot permissions:', error);
    return { canKick: false, canInvite: false, canRestrict: false };
  }
}
