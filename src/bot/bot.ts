import { Bot } from 'grammy';
import { config } from '../config.js';
import { adminHandlers } from './handlers/admin.js';
import { verifyHandlers } from './handlers/verify.js';
import { joinHandlers } from './handlers/join.js';

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  // Error handler
  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  // Register handlers
  bot.use(joinHandlers);
  bot.use(adminHandlers);
  bot.use(verifyHandlers);

  // Help command (available to everyone)
  bot.command('help', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      await ctx.reply(
        `🤖 **BCH Wallet Verification Bot**\n\n` +
        `I help Telegram groups restrict access based on wallet contents.\n\n` +
        `**User Commands:**\n` +
        `/verify - Verify your wallet\n` +
        `/status - Check your access status\n` +
        `/list\\_verifications - List your verifications\n` +
        `/unverify - Remove a verification\n` +
        `/cancel - Cancel verification\n` +
        `/help - Show this help\n\n` +
        `**Admin Commands (in groups):**\n` +
        `/setup - Initialize bot for group\n` +
        `/add\\_condition - Add access condition\n` +
        `/remove\\_condition - Remove access condition\n` +
        `/list\\_conditions - List access conditions\n` +
        `/groupinfo - Show group configuration\n` +
        `/adminhelp - Full admin help`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        `Use /adminhelp for admin commands.\n` +
        `For verification, message me directly.`
      );
    }
  });

  return bot;
}
