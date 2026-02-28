import { Context, Composer } from 'grammy';
import { requireGroupAdmin, checkBotPermissions } from '../middleware/auth.js';
import {
  upsertGroup,
  addNftCategory,
  removeNftCategory,
  getNftCategories,
  isGroupConfigured,
  getGroup,
  getVerificationsForMonitoring,
  deleteVerification,
} from '../../storage/queries.js';
import { isValidCategoryId, checkNftOwnership } from '../../blockchain/nft.js';
import { fetchTokenMetadata, formatTokenName } from '../../blockchain/bcmr.js';
import { checkGroupVerifications } from '../../blockchain/monitor.js';

export const adminHandlers = new Composer();

// /setup - Initialize bot for a group
adminHandlers.command('setup', requireGroupAdmin, async (ctx: Context) => {
  if (ctx.chat?.type === 'private') {
    await ctx.reply(
      'This command must be used in a group.\n\n' +
      'Add me to a group as an administrator, then use /setup there.'
    );
    return;
  }

  const chatId = ctx.chat!.id;
  const chatTitle = ctx.chat && 'title' in ctx.chat ? ctx.chat.title : 'Unknown Group';

  // Check bot permissions
  const perms = await checkBotPermissions(ctx);
  if (!perms.canKick || !perms.canRestrict) {
    await ctx.reply(
      '⚠️ I need administrator permissions to manage this group.\n\n' +
      'Please make sure I have these permissions:\n' +
      '• Ban users (to kick unverified members)\n' +
      '• Restrict members\n\n' +
      'Then run /setup again.'
    );
    return;
  }

  // Register group in database
  upsertGroup(chatId, chatTitle);

  const configured = isGroupConfigured(chatId);
  const botUsername = ctx.me.username;
  const deepLink = `https://t.me/${botUsername}?start=verify_${chatId}`;
  // Escape underscores for Markdown
  const deepLinkEscaped = deepLink.replace(/_/g, '\\_');

  await ctx.reply(
    `✅ Bot is set up for this group!\n\n` +
    `Group: ${chatTitle}\n` +
    `ID: ${chatId}\n\n` +
    (configured
      ? 'NFT categories are already configured. Use /status to view them.'
      : 'Next step: Add NFT categories with /add\\_category <category\\_id>') +
    `\n\n**Verification link for existing members:**\n${deepLinkEscaped}`,
    { parse_mode: 'Markdown' }
  );
});

// /add_category <category> - Add NFT category for group access
adminHandlers.command('add_category', requireGroupAdmin, async (ctx: Context) => {
  const chatId = ctx.chat?.type === 'private' ? null : ctx.chat?.id;
  const args = ctx.match as string;

  if (!args) {
    await ctx.reply(
      'Usage: /add_category <category_id>\n\n' +
      'The category ID is a 64-character hex string (transaction ID of the NFT genesis).\n\n' +
      'Example:\n' +
      '/add_category 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    );
    return;
  }

  const category = args.trim().toLowerCase();

  if (!isValidCategoryId(category)) {
    await ctx.reply(
      '❌ Invalid category ID format.\n\n' +
      'Category ID must be a 64-character hexadecimal string.'
    );
    return;
  }

  if (ctx.chat?.type === 'private') {
    await ctx.reply('This command must be used in a group.');
    return;
  }

  const group = getGroup(chatId!);
  if (!group) {
    await ctx.reply('Please run /setup first to initialize this group.');
    return;
  }

  addNftCategory(chatId!, category);

  const categories = getNftCategories(chatId!);

  // Fetch metadata for nice display
  const metadata = await fetchTokenMetadata(category);
  const displayName = formatTokenName(category, metadata);

  await ctx.reply(
    `✅ NFT category added!\n\n` +
    `Token: ${displayName}\n` +
    `Category: \`${category}\`\n\n` +
    `This group now accepts ${categories.length} NFT categor${categories.length === 1 ? 'y' : 'ies'} for verification.`,
    { parse_mode: 'Markdown' }
  );
});

// /remove_category <category> - Remove NFT category
adminHandlers.command('remove_category', requireGroupAdmin, async (ctx: Context) => {
  const chatId = ctx.chat?.type === 'private' ? null : ctx.chat?.id;
  const args = ctx.match as string;

  if (!args) {
    await ctx.reply('Usage: /remove_category <category_id>');
    return;
  }

  if (ctx.chat?.type === 'private') {
    await ctx.reply('This command must be used in a group.');
    return;
  }

  const category = args.trim().toLowerCase();
  removeNftCategory(chatId!, category);

  await ctx.reply(`✅ NFT category removed. Checking affected verifications...`);

  // Immediately check all verifications for this group
  const result = await checkGroupVerifications(chatId!);

  if (result.checked === 0) {
    await ctx.reply(`No verifications to check.`);
  } else {
    let msg = `Verification check complete:\n`;
    msg += `• Checked: ${result.checked}\n`;
    msg += `• Valid: ${result.valid}\n`;
    if (result.switched > 0) msg += `• Switched to different NFT: ${result.switched}\n`;
    if (result.invalid > 0) msg += `• Removed (no qualifying NFT): ${result.invalid}`;
    await ctx.reply(msg);
  }
});

// /list_categories - List configured NFT categories (available to all users)
adminHandlers.command('list_categories', async (ctx: Context) => {
  if (ctx.chat?.type === 'private') {
    await ctx.reply('This command must be used in a group.');
    return;
  }

  const chatId = ctx.chat!.id;
  const group = getGroup(chatId);

  if (!group) {
    await ctx.reply('This group is not set up for NFT verification.');
    return;
  }

  const categories = getNftCategories(chatId);

  if (categories.length === 0) {
    await ctx.reply('No NFT categories configured for this group.');
    return;
  }

  // Fetch metadata for all categories
  const metadataPromises = categories.map(cat => fetchTokenMetadata(cat));
  const metadataResults = await Promise.all(metadataPromises);

  let msg = `**NFT Categories (${categories.length}):**\n\n`;
  categories.forEach((cat, i) => {
    const displayName = formatTokenName(cat, metadataResults[i]);
    msg += `${i + 1}. ${displayName}\n`;
    msg += `   \`${cat}\`\n\n`;
  });

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// /status - Show group configuration
adminHandlers.command('status', requireGroupAdmin, async (ctx: Context) => {
  if (ctx.chat?.type === 'private') {
    await ctx.reply('This command must be used in a group.');
    return;
  }

  const chatId = ctx.chat!.id;
  const group = getGroup(chatId);

  if (!group) {
    await ctx.reply(
      'This group is not set up yet.\n\n' +
      'Run /setup to initialize.'
    );
    return;
  }

  const categories = getNftCategories(chatId);
  const perms = await checkBotPermissions(ctx);

  let statusMsg = `📊 **Group Status**\n\n`;
  statusMsg += `**Name:** ${group.name}\n`;
  statusMsg += `**ID:** ${group.id}\n`;
  statusMsg += `**Set up:** ${group.created_at}\n\n`;

  statusMsg += `**Bot Permissions:**\n`;
  statusMsg += `• Can kick: ${perms.canKick ? '✅' : '❌'}\n`;
  statusMsg += `• Can invite: ${perms.canInvite ? '✅' : '❌'}\n`;
  statusMsg += `• Can restrict: ${perms.canRestrict ? '✅' : '❌'}\n\n`;

  statusMsg += `**NFT Categories:** ${categories.length}\n`;
  if (categories.length > 0) {
    // Fetch metadata for all categories
    const metadataPromises = categories.map(cat => fetchTokenMetadata(cat));
    const metadataResults = await Promise.all(metadataPromises);

    categories.forEach((cat, i) => {
      const displayName = formatTokenName(cat, metadataResults[i]);
      statusMsg += `${i + 1}. ${displayName}\n`;
    });
  } else {
    statusMsg += '_No categories configured. Use /add\\_category to add one._';
  }

  await ctx.reply(statusMsg, { parse_mode: 'Markdown' });
});

// /scan - Re-check all verified users in this group
adminHandlers.command('scan', requireGroupAdmin, async (ctx: Context) => {
  if (ctx.chat?.type === 'private') {
    await ctx.reply('This command must be used in a group.');
    return;
  }

  const chatId = ctx.chat!.id;
  const group = getGroup(chatId);

  if (!group) {
    await ctx.reply('This group is not set up. Run /setup first.');
    return;
  }

  const categories = getNftCategories(chatId);
  if (categories.length === 0) {
    await ctx.reply('No NFT categories configured.');
    return;
  }

  await ctx.reply('🔍 Scanning verified users...');

  const verifications = getVerificationsForMonitoring().filter(
    v => v.group_id === chatId
  );

  if (verifications.length === 0) {
    await ctx.reply('No verified users to check.');
    return;
  }

  let checked = 0;
  let valid = 0;
  let invalid = 0;
  let kicked = 0;
  let adminSkipped = 0;

  for (const verification of verifications) {
    checked++;

    try {
      const ownedNfts = await checkNftOwnership(verification.bch_address, categories);

      if (ownedNfts.length > 0) {
        valid++;
        continue;
      }

      invalid++;

      // Check if user is admin
      const member = await ctx.api.getChatMember(chatId, verification.telegram_user_id);
      if (member.status === 'administrator' || member.status === 'creator') {
        adminSkipped++;
        deleteVerification(verification.id);
        continue;
      }

      // Kick user with short ban (auto-unbans after 35 seconds)
      try {
        await ctx.api.banChatMember(chatId, verification.telegram_user_id, {
          until_date: Math.floor(Date.now() / 1000) + 35,
        });
        kicked++;

        // Notify user
        await ctx.api.sendMessage(
          verification.telegram_user_id,
          `You have been removed from "${group.name}" because you no longer hold a qualifying NFT.\n\n` +
          `If you still own a qualifying NFT, you can rejoin and verify again.`
        ).catch(() => {}); // Ignore DM errors
      } catch (kickError) {
        console.error(`Failed to kick user ${verification.telegram_user_id}:`, kickError);
      }

      deleteVerification(verification.id);

    } catch (error) {
      console.error(`Error checking verification ${verification.id}:`, error);
    }
  }

  await ctx.reply(
    `✅ Scan complete!\n\n` +
    `Checked: ${checked}\n` +
    `Valid: ${valid}\n` +
    `Invalid: ${invalid}\n` +
    `Kicked: ${kicked}\n` +
    `Admins skipped: ${adminSkipped}`
  );
});

// /help - Show admin help
adminHandlers.command('adminhelp', requireGroupAdmin, async (ctx: Context) => {
  await ctx.reply(
    `🔧 **Admin Commands**\n\n` +
    `/setup - Initialize bot for this group\n` +
    `/add\\_category <category> - Add NFT category for access\n` +
    `/remove\\_category <category> - Remove NFT category\n` +
    `/list\\_categories - List configured NFT categories\n` +
    `/status - Show full group configuration\n` +
    `/scan - Re-check all verified users now\n\n` +
    `**How it works:**\n` +
    `1. Add bot to group as admin\n` +
    `2. Run /setup to initialize\n` +
    `3. Add NFT categories with /add\\_category\n` +
    `4. Enable "Hidden message history" in group settings\n` +
    `5. New members will be kicked and asked to verify NFT ownership via DM`,
    { parse_mode: 'Markdown' }
  );
});
