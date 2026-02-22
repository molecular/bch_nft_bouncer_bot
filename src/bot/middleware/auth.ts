import { Context, NextFunction } from 'grammy';

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

  // Admin commands only work in groups
  if (ctx.chat?.type === 'private') {
    await ctx.reply('This command must be used in a group.');
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
