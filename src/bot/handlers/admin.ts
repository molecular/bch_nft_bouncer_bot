import { Context, Composer } from 'grammy';
import { requireGroupAdmin, checkBotPermissions } from '../middleware/auth.js';
import {
  upsertGroup,
  isGroupConfigured,
  getGroup,
  addAccessRule,
  getAccessRules,
  getAccessRuleById,
  removeAccessRule,
} from '../../storage/queries.js';
import { isValidCategoryId } from '../../blockchain/nft.js';
import { fetchTokenMetadata, formatTokenName } from '../../blockchain/bcmr.js';
import { checkGroupVerifications } from '../../blockchain/monitor.js';
import { escapeMarkdown } from '../utils/verification.js';
import type { AccessRule } from '../../storage/types.js';

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
      ? 'NFT categories are already configured. Use /groupinfo to view them.'
      : 'Next step: Add NFT categories with /add\\_category <category\\_id>') +
    `\n\n*Verification link for existing members:*\n${deepLinkEscaped}`,
    { parse_mode: 'Markdown' }
  );
});

// ============ Access Condition Commands ============

// /add_condition nft <category> [label] [start] [end]
// /add_condition balance <category|BCH> <min_amount> [label]
adminHandlers.command('add_condition', requireGroupAdmin, async (ctx: Context) => {
  const chatId = ctx.chat?.type === 'private' ? null : ctx.chat?.id;
  const args = (ctx.match as string || '').trim();

  if (!args) {
    await ctx.reply(
      '*Usage:*\n\n' +
      '`/add_condition nft <category> [label] [start] [end]`\n' +
      '  Add NFT requirement with optional commitment range\n\n' +
      '`/add_condition balance <amount> <BCH|category>`\n' +
      '  Add balance requirement (BCH or token)\n\n' +
      '*Examples:*\n' +
      '`/add_condition nft abc123...`\n' +
      '`/add_condition nft abc123... Jessicas 01 64`\n' +
      '`/add_condition balance 21 BCH`\n' +
      '`/add_condition balance 1000 def456...`',
      { parse_mode: 'Markdown' }
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

  const parts = args.split(/\s+/);
  const ruleType = parts[0]?.toLowerCase();

  if (ruleType === 'nft') {
    // /add_condition nft <category> [label] [start] [end]
    if (parts.length < 2) {
      await ctx.reply('Usage: `/add_condition nft <category> [label] [start] [end]`', { parse_mode: 'Markdown' });
      return;
    }

    const category = parts[1].toLowerCase();
    if (!isValidCategoryId(category)) {
      await ctx.reply('Invalid category ID. Must be a 64-character hex string.');
      return;
    }

    let label: string | undefined;
    let startCommitment: string | undefined;
    let endCommitment: string | undefined;

    // Parse optional arguments
    if (parts.length >= 3) {
      // Check if third part looks like a hex commitment (short) or a label
      if (parts.length >= 4 && /^[0-9a-fA-F]+$/.test(parts[2]) && /^[0-9a-fA-F]+$/.test(parts[3])) {
        // Format: nft <category> <start> <end>
        startCommitment = parts[2].toLowerCase();
        endCommitment = parts[3].toLowerCase();
      } else if (parts.length >= 5 && /^[0-9a-fA-F]+$/.test(parts[3]) && /^[0-9a-fA-F]+$/.test(parts[4])) {
        // Format: nft <category> <label> <start> <end>
        label = parts[2];
        startCommitment = parts[3].toLowerCase();
        endCommitment = parts[4].toLowerCase();
      } else if (parts.length === 3) {
        // Format: nft <category> <label>
        label = parts[2];
      }
    }

    try {
      const ruleId = addAccessRule(chatId!, 'nft', category, {
        startCommitment,
        endCommitment,
        label,
      });

      // Fetch metadata for display
      const metadata = await fetchTokenMetadata(category);
      const displayName = formatTokenName(category, metadata);

      let msg = `✅ NFT condition added (ID: ${ruleId})\n\n`;
      msg += `*Token:* ${displayName}\n`;
      if (label) msg += `*Label:* ${label}\n`;
      if (startCommitment && endCommitment) {
        msg += `*Range:* \`${startCommitment}\` - \`${endCommitment}\`\n`;
      }

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (error: any) {
      if (error.message?.includes('UNIQUE constraint')) {
        await ctx.reply('This condition already exists.');
      } else {
        console.error('Error adding NFT condition:', error);
        await ctx.reply('Failed to add condition.');
      }
    }

  } else if (ruleType === 'balance') {
    // /add_condition balance <amount> <BCH|category_id>
    if (parts.length < 3) {
      await ctx.reply('Usage: `/add_condition balance <amount> <BCH|category_id>`', { parse_mode: 'Markdown' });
      return;
    }

    const amountArg = parts[1];
    const categoryArg = parts[2];

    let category: string;
    let minAmount: string;
    let autoLabel: string | undefined;

    if (categoryArg.toUpperCase() === 'BCH') {
      category = 'BCH';
      // Amount is in BCH, convert to satoshis
      const bchAmount = parseFloat(amountArg);
      if (isNaN(bchAmount) || bchAmount <= 0) {
        await ctx.reply('Invalid BCH amount. Must be a positive number.');
        return;
      }
      minAmount = (BigInt(Math.round(bchAmount * 100000000))).toString();
      // Auto-generate label for BCH
      const bchDisplay = bchAmount.toFixed(8).replace(/\.?0+$/, '');
      autoLabel = `${bchDisplay} BCH`;
    } else {
      // Fungible token
      if (!isValidCategoryId(categoryArg)) {
        await ctx.reply('Invalid category ID. Must be a 64-character hex string or "BCH".');
        return;
      }
      category = categoryArg.toLowerCase();

      // Amount is in base units
      try {
        minAmount = BigInt(amountArg).toString();
        if (BigInt(minAmount) <= 0n) throw new Error('non-positive');
      } catch {
        await ctx.reply('Invalid amount. Must be a positive integer.');
        return;
      }

      // Auto-generate label from token metadata
      const metadata = await fetchTokenMetadata(category);
      if (metadata?.symbol) {
        autoLabel = `${minAmount} ${metadata.symbol}`;
      } else if (metadata?.name) {
        autoLabel = `${minAmount} ${metadata.name}`;
      }
    }

    try {
      const ruleId = addAccessRule(chatId!, 'balance', category, {
        minAmount,
        label: autoLabel,
      });

      let msg = `✅ Balance condition added (ID: ${ruleId})\n\n`;
      if (category === 'BCH') {
        const bchDisplay = (Number(minAmount) / 100000000).toFixed(8).replace(/\.?0+$/, '');
        msg += `*Requirement:* ${bchDisplay} BCH\n`;
      } else {
        const metadata = await fetchTokenMetadata(category);
        const displayName = formatTokenName(category, metadata);
        msg += `*Token:* ${displayName}\n`;
        msg += `*Minimum:* ${minAmount}\n`;
      }
      if (autoLabel) msg += `*Label:* ${autoLabel}\n`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (error: any) {
      if (error.message?.includes('UNIQUE constraint')) {
        await ctx.reply('This condition already exists.');
      } else {
        console.error('Error adding balance condition:', error);
        await ctx.reply('Failed to add condition.');
      }
    }

  } else {
    await ctx.reply(
      'Unknown condition type. Use:\n' +
      '`/add_condition nft ...` or `/add_condition balance ...`',
      { parse_mode: 'Markdown' }
    );
  }
});

// /list_conditions - List all access rules
adminHandlers.command('list_conditions', async (ctx: Context) => {
  if (ctx.chat?.type === 'private') {
    await ctx.reply('This command must be used in a group.');
    return;
  }

  const chatId = ctx.chat!.id;
  const group = getGroup(chatId);

  if (!group) {
    await ctx.reply('This group is not set up for wallet verification.');
    return;
  }

  const rules = getAccessRules(chatId);

  if (rules.length === 0) {
    await ctx.reply('No access conditions configured for this group.\n\nUse `/add_condition` to add one.', { parse_mode: 'Markdown' });
    return;
  }

  const nftRules = rules.filter(r => r.rule_type === 'nft');
  const balanceRules = rules.filter(r => r.rule_type === 'balance');

  let msg = '*Access Conditions:*\n\n';

  if (nftRules.length > 0) {
    msg += '  *NFT:* _(at least one required)_\n';

    // Fetch metadata for all categories
    const categories = [...new Set(nftRules.map(r => r.category).filter(Boolean))];
    const metadataMap = new Map<string, any>();
    for (const cat of categories) {
      if (cat) {
        metadataMap.set(cat, await fetchTokenMetadata(cat));
      }
    }

    for (const rule of nftRules) {
      const metadata = rule.category ? metadataMap.get(rule.category) : null;
      const displayName = rule.category ? formatTokenName(rule.category, metadata) : 'Unknown';
      // Shorten category ID (first 8 + last 4 chars)
      const shortCat = rule.category ? `${rule.category.slice(0, 8)}...${rule.category.slice(-4)}` : '';

      msg += `    • *[${rule.id}]* ${rule.label || displayName}\n`;
      // Show shortened category ID (backticks allow tap-to-copy on mobile)
      msg += `        Category: \`${shortCat}\`\n`;
      if (rule.start_commitment && rule.end_commitment) {
        msg += `        Range: \`${rule.start_commitment}\` - \`${rule.end_commitment}\`\n`;
      }
    }
    msg += '\n';
  }

  if (balanceRules.length > 0) {
    msg += '  *Balance:* _(at least one required)_\n';

    for (const rule of balanceRules) {
      if (rule.category?.toUpperCase() === 'BCH') {
        const bchAmount = Number(BigInt(rule.min_amount || '0')) / 100000000;
        const bchDisplay = bchAmount.toFixed(8).replace(/\.?0+$/, '');
        msg += `    • *[${rule.id}]* ${rule.label || `${bchDisplay} BCH`}\n`;
      } else {
        const metadata = rule.category ? await fetchTokenMetadata(rule.category) : null;
        const displayName = rule.category ? formatTokenName(rule.category, metadata) : 'Unknown';
        // Shorten category ID (first 8 + last 4 chars)
        const shortCat = rule.category ? `${rule.category.slice(0, 8)}...${rule.category.slice(-4)}` : '';
        // Use label if set (which now auto-includes symbol), otherwise show amount + token name
        if (rule.label) {
          msg += `    • *[${rule.id}]* ${rule.label}\n`;
        } else {
          msg += `    • *[${rule.id}]* ${rule.min_amount} ${displayName}\n`;
        }
        // Show shortened category ID (backticks allow tap-to-copy on mobile)
        msg += `        Category: \`${shortCat}\`\n`;
      }
    }
    msg += '\n';
  }

  msg += 'Use /remove\\_condition <id> to remove.';

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// /remove_condition <id|name> - Remove an access rule by ID or name
adminHandlers.command('remove_condition', requireGroupAdmin, async (ctx: Context) => {
  const chatId = ctx.chat?.type === 'private' ? null : ctx.chat?.id;
  const args = (ctx.match as string || '').trim();

  if (!args) {
    await ctx.reply('Usage: `/remove_condition <id or name>`\n\nUse `/list_conditions` to see conditions.', { parse_mode: 'Markdown' });
    return;
  }

  if (ctx.chat?.type === 'private') {
    await ctx.reply('This command must be used in a group.');
    return;
  }

  let rule: AccessRule | undefined;

  // Try to parse as a numeric ID first
  const ruleId = parseInt(args, 10);
  if (!isNaN(ruleId)) {
    rule = getAccessRuleById(ruleId);
    if (rule && rule.group_id !== chatId) {
      await ctx.reply('This condition does not belong to this group.');
      return;
    }
  }

  // If not found by ID, try to match by label or symbol
  if (!rule) {
    const allRules = getAccessRules(chatId!);
    const searchTerm = args.toLowerCase();

    // Find rules that match the search term (case-insensitive)
    const matchingRules = allRules.filter(r => {
      // Match by label
      if (r.label?.toLowerCase().includes(searchTerm)) return true;
      // Match by category (if it starts with the search term)
      if (r.category?.toLowerCase().startsWith(searchTerm)) return true;
      return false;
    });

    if (matchingRules.length === 0) {
      // No matches - try fetching metadata for token symbol matching
      const rulesWithMetadata: { rule: AccessRule; symbol?: string; name?: string }[] = [];
      for (const r of allRules) {
        if (r.category && r.category !== 'BCH') {
          const metadata = await fetchTokenMetadata(r.category);
          rulesWithMetadata.push({
            rule: r,
            symbol: metadata?.symbol?.toLowerCase(),
            name: metadata?.name?.toLowerCase(),
          });
        } else {
          rulesWithMetadata.push({ rule: r });
        }
      }

      const metadataMatches = rulesWithMetadata.filter(rm =>
        rm.symbol?.includes(searchTerm) || rm.name?.includes(searchTerm)
      );

      if (metadataMatches.length === 1) {
        rule = metadataMatches[0].rule;
      } else if (metadataMatches.length > 1) {
        // Multiple matches - list them
        let msg = `Multiple conditions match "${args}":\n\n`;
        for (const rm of metadataMatches) {
          const displayName = rm.rule.label || rm.symbol || rm.name || rm.rule.category?.slice(0, 12);
          msg += `• [${rm.rule.id}] ${displayName}\n`;
        }
        msg += `\nUse the ID number to remove a specific condition.`;
        await ctx.reply(msg);
        return;
      } else {
        await ctx.reply(`No condition found matching "${args}".\n\nUse \`/list_conditions\` to see available conditions.`, { parse_mode: 'Markdown' });
        return;
      }
    } else if (matchingRules.length === 1) {
      rule = matchingRules[0];
    } else {
      // Multiple matches by label - list them
      let msg = `Multiple conditions match "${args}":\n\n`;
      for (const r of matchingRules) {
        const displayName = r.label || r.category?.slice(0, 12);
        msg += `• [${r.id}] ${displayName}\n`;
      }
      msg += `\nUse the ID number to remove a specific condition.`;
      await ctx.reply(msg);
      return;
    }
  }

  if (!rule) {
    await ctx.reply('Condition not found.');
    return;
  }

  const displayName = rule.label || rule.category?.slice(0, 12) || `#${rule.id}`;
  removeAccessRule(rule.id);

  await ctx.reply(`✅ Condition "${displayName}" (ID: ${rule.id}) removed. Checking affected verifications...`);

  // Check all verifications for this group
  const result = await checkGroupVerifications(chatId!);

  if (result.checked === 0) {
    await ctx.reply('No verifications to check.');
  } else {
    let msg = `Verification check complete:\n`;
    msg += `• Checked: ${result.checked}\n`;
    msg += `• Valid: ${result.valid}\n`;
    if (result.invalid > 0) msg += `• Restricted (no longer qualify): ${result.invalid}`;
    await ctx.reply(msg);
  }
});

// /groupinfo - Show group configuration (admin only)
adminHandlers.command('groupinfo', requireGroupAdmin, async (ctx: Context) => {
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

  const rules = getAccessRules(chatId);
  const nftRules = rules.filter(r => r.rule_type === 'nft');
  const balanceRules = rules.filter(r => r.rule_type === 'balance');
  const perms = await checkBotPermissions(ctx);

  let statusMsg = `*Group Status*\n\n`;
  statusMsg += `*Name:* ${escapeMarkdown(group.name || 'Unknown')}\n`;
  statusMsg += `*ID:* ${group.id}\n`;
  statusMsg += `*Set up:* ${group.created_at}\n\n`;

  statusMsg += `*Bot Permissions:*\n`;
  statusMsg += `• Can kick: ${perms.canKick ? '■' : '□'}\n`;
  statusMsg += `• Can restrict: ${perms.canRestrict ? '■' : '□'}\n\n`;

  statusMsg += `*Access Conditions:* ${rules.length} total\n`;
  if (nftRules.length > 0) {
    statusMsg += `• NFT rules: ${nftRules.length}\n`;
  }
  if (balanceRules.length > 0) {
    statusMsg += `• Balance rules: ${balanceRules.length}\n`;
  }

  if (rules.length === 0) {
    statusMsg += 'No conditions configured. Use `/add_condition` to add one.';
  } else {
    statusMsg += '\nUse `/list_conditions` for details.';
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

  const rules = getAccessRules(chatId);
  if (rules.length === 0) {
    await ctx.reply('No access conditions configured. Use /add\\_condition to add one.', { parse_mode: 'Markdown' });
    return;
  }

  await ctx.reply('🔍 Scanning verified users...');

  const result = await checkGroupVerifications(chatId);

  if (result.checked === 0) {
    await ctx.reply('No verified users to check.');
  } else {
    let msg = `✅ Scan complete!\n\n`;
    msg += `Checked: ${result.checked}\n`;
    msg += `Valid: ${result.valid}\n`;
    if (result.invalid > 0) msg += `Restricted (no longer qualify): ${result.invalid}`;
    await ctx.reply(msg);
  }
});

// /help - Show admin help
adminHandlers.command('adminhelp', requireGroupAdmin, async (ctx: Context) => {
  await ctx.reply(
    `*Admin Commands*\n\n` +
    `*--- Setup ---*\n` +
    `/setup - Initialize bot for this group\n` +
    `/groupinfo - Show group configuration summary\n\n` +
    `*--- Access Conditions ---*\n` +
    `/add\\_condition nft <cat> [label] [start] [end] - NFT with optional commitment range\n` +
    `/add\\_condition balance <amount> <BCH|cat> - BCH or token balance\n` +
    `/list\\_conditions - List all access conditions\n` +
    `/remove\\_condition <id or name> - Remove a condition by ID or name\n\n` +
    `*--- Management ---*\n` +
    `/scan - Re-check all verified users now\n\n` +
    `*--- Access Logic ---*\n` +
    `• NFT rules: OR - satisfy at least one\n` +
    `• Balance rules: OR - satisfy at least one\n` +
    `• Between types: AND - need at least one of each type configured`,
    { parse_mode: 'Markdown' }
  );
});
