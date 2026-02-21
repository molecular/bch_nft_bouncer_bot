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
        `🤖 **NFT Entry Bot**\n\n` +
        `I help Telegram groups restrict access to NFT holders.\n\n` +
        `**User Commands:**\n` +
        `/start - Start the bot\n` +
        `/verify - Verify NFT ownership\n` +
        `/wc - Connect wallet via WalletConnect\n` +
        `/cancel - Cancel verification\n` +
        `/help - Show this help\n\n` +
        `**Admin Commands (in groups):**\n` +
        `/setup - Initialize bot for group\n` +
        `/addnft - Add NFT category\n` +
        `/removenft - Remove NFT category\n` +
        `/status - Show group configuration\n` +
        `/adminhelp - Admin help`,
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
