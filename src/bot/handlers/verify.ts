import { Context, Composer } from 'grammy';
import { InputFile } from 'grammy';
import {
  createChallenge,
  getActiveChallenge,
  updateChallengeAddress,
  deleteChallenge,
  getPendingKicksForUser,
  getPendingKick,
  addPendingKick,
  deletePendingKick,
  addVerification,
  getVerification,
  getVerificationByAddress,
  getVerificationsForUser,
  getVerificationById,
  deleteVerification,
  getNftCategories,
  getGroup,
  isGroupConfigured,
  getAccessRules,
  getVerificationsByAddress,
  getVerificationsForMonitoring,
} from '../../storage/queries.js';
import { checkNftOwnership, isValidCategoryId, checkAccessRules, checkAccessRulesMultiAddress } from '../../blockchain/nft.js';
import { fetchTokenMetadata, formatTokenName, formatNftDisplay } from '../../blockchain/bcmr.js';
import { sendVerifiedMessage } from '../utils/verification.js';
import { verifySignedMessage, generateChallengeMessage, isValidBchAddress } from '../../blockchain/verify.js';
import { createPairing, getUserSession, disconnectSession, checkAndClearRejection } from '../../walletconnect/session.js';
import { generateQRBuffer } from '../../walletconnect/qr.js';
import { requestAddresses, requestSignMessage } from '../../walletconnect/sign.js';
import { config } from '../../config.js';
import { unrestrictUser } from '../utils/permissions.js';
import { addAddressToMonitor, removeAddressFromMonitor, checkUserVerification } from '../../blockchain/monitor.js';
import type { AccessRule } from '../../storage/types.js';

export const verifyHandlers = new Composer();

// Conversation state for verification flow
const verificationState: Map<number, {
  step: 'address' | 'signature' | 'wc_waiting' | 'wc_sign_pending';
  groupId: number;
  groupName: string;
  challenge?: ReturnType<typeof createChallenge>;
  challengeMessage?: string;
  address?: string;
  wcPairingTopic?: string;
}> = new Map();

// /start - Handle start with or without deep link
verifyHandlers.command('start', async (ctx: Context) => {
  if (ctx.chat?.type !== 'private') {
    return; // Only handle in private chat
  }

  const userId = ctx.from!.id;
  const args = ctx.match as string;

  // Check for deep link parameter (e.g., /start verify_-1001234567890)
  if (args && args.startsWith('verify_')) {
    const groupIdStr = args.replace('verify_', '');
    const groupId = parseInt(groupIdStr, 10);

    if (isNaN(groupId)) {
      await ctx.reply('Invalid verification link.');
      return;
    }

    // Start verification for this group
    await startVerification(ctx, userId, groupId);
    return;
  }

  // Regular /start
  const pendingKicks = getPendingKicksForUser(userId);

  if (pendingKicks.length > 0) {
    // User has pending verifications
    let msg = `👋 Welcome! You need to verify your wallet to access the following group(s):\n\n`;

    for (const pk of pendingKicks) {
      const group = getGroup(pk.group_id);
      msg += `• ${group?.name || `Group ${pk.group_id}`}\n`;
    }

    msg += `\nUse /verify to start the verification process.`;

    await ctx.reply(msg);
  } else {
    await ctx.reply(
      `👋 Welcome to the BCH Wallet Verification Bot!\n\n` +
      `I help Telegram groups restrict access based on wallet contents (NFTs, tokens, BCH balance).\n\n` +
      `**For users:**\n` +
      `• When you join a gated group, you'll be asked to verify your wallet\n` +
      `• Use /verify to start verification\n\n` +
      `**For group admins:**\n` +
      `• Add me to your group as an admin\n` +
      `• Use /adminhelp for setup instructions`,
      { parse_mode: 'Markdown' }
    );
  }
});

// /verify - Start verification process
verifyHandlers.command('verify', async (ctx: Context) => {
  console.log(`/verify command received, chat type: ${ctx.chat?.type}, chat id: ${ctx.chat?.id}`);
  if (ctx.chat?.type !== 'private') {
    // In a group, reply with the deeplink
    const chatId = ctx.chat!.id;
    const botUsername = ctx.me.username;
    const deepLink = `https://t.me/${botUsername}?start=verify_${chatId}`;
    await ctx.reply(
      `🔐 To verify your wallet, click here:\n${deepLink}`,
    );
    return;
  }

  const userId = ctx.from!.id;
  const pendingKicks = getPendingKicksForUser(userId);

  if (pendingKicks.length === 0) {
    await ctx.reply(
      "You don't have any pending verifications.\n\n" +
      "If you want to join a gated group, join it first and you'll be directed here for verification."
    );
    return;
  }

  if (pendingKicks.length === 1) {
    await startVerification(ctx, userId, pendingKicks[0].group_id);
  } else {
    // Multiple groups - let user choose
    let msg = `You have pending verifications for multiple groups:\n\n`;

    pendingKicks.forEach((pk, i) => {
      const group = getGroup(pk.group_id);
      msg += `${i + 1}. ${group?.name || `Group ${pk.group_id}`}\n`;
    });

    msg += `\nReply with the number of the group you want to verify for, or use the verification link sent when you joined.`;

    await ctx.reply(msg);
  }
});

async function startVerification(ctx: Context, userId: number, groupId: number): Promise<void> {
  const group = getGroup(groupId);
  if (!group) {
    await ctx.reply('This group is no longer configured for wallet verification.');
    return;
  }

  const rules = getAccessRules(groupId);
  if (rules.length === 0) {
    await ctx.reply('This group has no access conditions configured. Contact the group admin.');
    return;
  }

  // Check for existing verifications for this group
  const existingVerifications = getVerificationsForUser(userId).filter(v => v.group_id === groupId);
  const provenAddresses = [...new Set(existingVerifications.map(v => v.bch_address))];

  // Store state
  verificationState.set(userId, {
    step: 'address',
    groupId,
    groupName: group.name || `Group ${groupId}`,
  });

  // Build the verification message
  let msg = `🔐 **Verification for ${group.name}**\n\n`;

  // Show existing verifications if any
  if (existingVerifications.length > 0) {
    msg += `📋 **Your verified addresses:**\n`;
    for (const v of existingVerifications) {
      const addressShort = v.bch_address.slice(12, 22) + '...';
      msg += `• ${addressShort}\n`;
    }
    msg += `\n`;
  }

  // Check which rules are satisfied and show requirements
  if (provenAddresses.length > 0) {
    const result = await checkAccessRulesMultiAddress(provenAddresses, rules);

    // Show requirements with status
    msg += `**Requirements:**\n\n`;
    msg += await formatRequirementsMessage(rules, result);

    // Check if already satisfied
    if (result.satisfied) {
      msg += `\n✅ **All requirements satisfied!**\n`;
      deletePendingKick(userId, groupId);
      verificationState.delete(userId);
      await ctx.reply(msg, { parse_mode: 'Markdown' });
      await addUserToGroup(ctx, userId, groupId);
      return;
    }

    // Show what's still needed
    if (!result.nftSatisfied && !result.balanceSatisfied) {
      msg += `\n_Need at least one NFT AND one balance condition._\n`;
    } else if (!result.nftSatisfied) {
      msg += `\n_Need at least one NFT condition._\n`;
    } else if (!result.balanceSatisfied) {
      msg += `\n_Need at least one balance condition._\n`;
    }
  } else {
    // No verifications yet - show all requirements
    msg += `**Requirements:**\n\n`;
    msg += await formatRequirementsMessage(rules, null);
  }

  if (config.wcProjectId) {
    // WalletConnect is configured - send requirements first, then start WC flow automatically
    await ctx.reply(msg, { parse_mode: 'Markdown' });
    const state = verificationState.get(userId)!;
    await startWalletConnectFlow(ctx, userId, state);
  } else {
    // No WC configured - show manual-only instructions
    msg += `\n**To verify:**\nSend your BCH address\n`;
    msg += `Example: \`bitcoincash:qr...\`\n\n`;
    msg += `_You can verify multiple addresses if needed._`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  }
}

// Helper to format requirements with status (exported for use in monitor)
export async function formatRequirementsMessage(
  rules: AccessRule[],
  checkResult: Awaited<ReturnType<typeof checkAccessRulesMultiAddress>> | null
): Promise<string> {
  const nftRules = rules.filter(r => r.rule_type === 'nft');
  const balanceRules = rules.filter(r => r.rule_type === 'balance');

  let msg = '';

  if (nftRules.length > 0) {
    msg += `**NFT** _(at least one)_\n`;

    // Fetch metadata for all categories
    const categories = [...new Set(nftRules.map(r => r.category).filter(Boolean))];
    const metadataMap = new Map<string, any>();
    for (const cat of categories) {
      if (cat) {
        metadataMap.set(cat, await fetchTokenMetadata(cat));
      }
    }

    for (const rule of nftRules) {
      const ruleResult = checkResult?.nftResults.find(r => r.rule.id === rule.id);
      const satisfied = ruleResult?.satisfied ?? false;
      const icon = satisfied ? '✅' : '▫️';
      const metadata = rule.category ? metadataMap.get(rule.category) : null;
      const displayName = rule.label || (rule.category ? formatTokenName(rule.category, metadata) : 'Unknown');

      msg += `${icon} ${displayName}`;
      if (rule.start_commitment && rule.end_commitment) {
        msg += ` (${rule.start_commitment}-${rule.end_commitment})`;
      }
      msg += `\n`;
    }
    msg += '\n';
  }

  if (balanceRules.length > 0) {
    msg += `**Balance** _(at least one)_\n`;

    for (const rule of balanceRules) {
      const ruleResult = checkResult?.balanceResults.find(r => r.rule.id === rule.id);
      const satisfied = ruleResult?.satisfied ?? false;
      const icon = satisfied ? '✅' : '▫️';

      let displayName: string;
      if (rule.label) {
        // Label already includes amount info
        displayName = rule.label;
      } else if (rule.category?.toUpperCase() === 'BCH') {
        const bchAmount = Number(BigInt(rule.min_amount || '0')) / 100000000;
        const bchDisplay = bchAmount.toFixed(8).replace(/\.?0+$/, '');
        displayName = `${bchDisplay} BCH`;
      } else {
        const metadata = rule.category ? await fetchTokenMetadata(rule.category) : null;
        const tokenName = rule.category ? formatTokenName(rule.category, metadata) : 'Unknown';
        displayName = `${rule.min_amount} ${tokenName}`;
      }

      msg += `${icon} ${displayName}\n`;
    }
    msg += '\n';
  }

  return msg;
}

// Helper to format which conditions were satisfied (for success messages)
function formatSatisfiedConditions(
  result: Awaited<ReturnType<typeof checkAccessRulesMultiAddress>>
): string {
  const satisfiedNfts = result.nftResults.filter(r => r.satisfied);
  const satisfiedBalances = result.balanceResults.filter(r => r.satisfied);

  let msg = '';

  if (satisfiedNfts.length > 0) {
    for (const r of satisfiedNfts) {
      if (r.matchingNft) {
        msg += `NFT: ${r.rule.label || r.matchingNft.category.slice(0, 8)}`;
        if (r.matchingNft.commitment) {
          msg += ` (${r.matchingNft.commitment})`;
        }
        msg += '\n';
      }
    }
  }

  if (satisfiedBalances.length > 0) {
    for (const r of satisfiedBalances) {
      msg += `Balance: ${r.rule.label || r.rule.category}\n`;
    }
  }

  return msg;
}

// Helper to start WalletConnect flow (used by both startVerification and /wc command)
async function startWalletConnectFlow(
  ctx: Context,
  userId: number,
  state: NonNullable<ReturnType<typeof verificationState.get>>
): Promise<void> {
  // Disconnect any existing session and clear any pending rejection
  await disconnectSession(userId);
  checkAndClearRejection(userId);

  const chatId = ctx.chat!.id;
  const messagesToDelete: number[] = [];

  try {
    const connectingMsg = await ctx.reply('🔗 Connecting via WalletConnect...');
    messagesToDelete.push(connectingMsg.message_id);

    // Create pairing with timeout callback to clean up QR messages
    const { uri, pairingTopic } = await createPairing(userId, state.groupId, {
      onTimeout: async () => {
        // Delete QR-related messages
        for (const msgId of messagesToDelete) {
          try {
            await ctx.api.deleteMessage(chatId, msgId);
          } catch {
            // Message may already be deleted or too old
          }
        }
        // Notify user
        try {
          await ctx.api.sendMessage(
            chatId,
            '⏱️ QR code expired. Send /wc for a new one, or send your BCH address directly.'
          );
        } catch {
          // User may have blocked the bot
        }
      },
    });

    // Generate QR code
    const qrBuffer = await generateQRBuffer(uri);

    // Update state
    state.step = 'wc_waiting';
    state.wcPairingTopic = pairingTopic;

    // Send QR code
    const qrMsg = await ctx.replyWithPhoto(new InputFile(qrBuffer, 'walletconnect.png'), {
      caption:
        '📱 **Scan with your BCH wallet** (Paytaca, Cashonize, ...)\n\n' +
        'Or copy this link:',
      parse_mode: 'Markdown',
    });
    messagesToDelete.push(qrMsg.message_id);

    // Send URI in monospace for easy copying
    const uriMsg = await ctx.reply(`\`${uri}\``, { parse_mode: 'Markdown' });
    messagesToDelete.push(uriMsg.message_id);

    // Fallback option - prominent message for users without WC wallets
    const fallbackMsg = await ctx.reply(
      '💡 **Not using WalletConnect?**\n' +
      'Send your BCH address for manual verification:\n' +
      'Example: `bitcoincash:qr...`',
      { parse_mode: 'Markdown' }
    );
    messagesToDelete.push(fallbackMsg.message_id);

    // Start polling for wallet connection
    handleWcVerification(ctx, userId, state);

  } catch (error) {
    console.error('WalletConnect flow error:', error);
    // Fall back gracefully
    state.step = 'address';
    await ctx.reply(
      '⚠️ WalletConnect unavailable.\n\n' +
      'Send your BCH address for manual verification:\n' +
      'Example: `bitcoincash:qr...`'
    );
  }
}

// /wc - Start WalletConnect flow (for retries or adding another address)
verifyHandlers.command('wc', async (ctx: Context) => {
  if (ctx.chat?.type !== 'private') return;

  const userId = ctx.from!.id;
  const state = verificationState.get(userId);

  if (!state) {
    await ctx.reply('Please start with /verify first.');
    return;
  }

  if (!config.wcProjectId) {
    await ctx.reply(
      'WalletConnect is not configured on this bot.\n\n' +
      'Please use manual verification by sending your BCH address.'
    );
    return;
  }

  // Use the shared helper for starting WC flow
  await startWalletConnectFlow(ctx, userId, state);
});

// /sign - Resend signature request (after rejection)
verifyHandlers.command('sign', async (ctx: Context) => {
  if (ctx.chat?.type !== 'private') return;

  const userId = ctx.from!.id;
  const state = verificationState.get(userId);

  if (!state || state.step !== 'wc_sign_pending') {
    await ctx.reply('No pending signature request. Use /verify to start verification.');
    return;
  }

  if (!state.address || !state.challengeMessage) {
    await ctx.reply('Session expired. Please use /wc to reconnect.');
    state.step = 'address';
    return;
  }

  // Check if session is still active
  const session = getUserSession(userId);
  if (!session) {
    await ctx.reply('Wallet disconnected. Please use /wc to reconnect.');
    state.step = 'address';
    return;
  }

  await ctx.reply('📝 Resending signature request to your wallet...');

  try {
    const signature = await requestSignMessage(userId, state.challengeMessage, state.address);

    // Verify signature
    const sigValid = await verifySignedMessage(state.challengeMessage, signature, state.address);
    if (!sigValid) {
      await ctx.reply('❌ Signature verification failed. Please try again with /sign');
      return;
    }

    // Check access rules
    const rules = getAccessRules(state.groupId);
    const existingVerifications = getVerificationsForUser(userId).filter(v => v.group_id === state.groupId);
    const allAddresses = [...new Set([...existingVerifications.map(v => v.bch_address), state.address])];
    const result = await checkAccessRulesMultiAddress(allAddresses, rules);

    // Store verification
    const username = ctx.from?.username || null;
    addVerification(userId, username, state.groupId, state.address);
    await addAddressToMonitor(state.address);
    if (state.challenge) {
      deleteChallenge(state.challenge.id);
    }

    if (result.satisfied) {
      deletePendingKick(userId, state.groupId);

      // Build success message showing what was satisfied
      let msg = '✅ **Verification successful!**\n\n';
      msg += formatSatisfiedConditions(result);
      msg += '\nYou now have full access to the group!';

      await ctx.reply(msg, { parse_mode: 'Markdown' });

      // Try to add user back to group
      await addUserToGroup(ctx, userId, state.groupId);
    } else {
      // Show progress
      let msg = '✅ **Address verified!**\n\n';
      msg += `Address: \`${state.address.slice(0, 20)}...\`\n\n`;
      msg += '**Condition Progress:**\n\n';
      msg += await formatRequirementsMessage(rules, result);
      msg += `\nProve another address via /wc or paste address, or /cancel.`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      state.step = 'address';
      return; // Don't add to group yet
    }

    await disconnectSession(userId);
    verificationState.delete(userId);

  } catch (error: any) {
    console.error('Sign retry error:', error);

    const isRejection = error?.message?.includes('rejected') || error?.message?.includes('Rejected') || error?.code === 5000;
    const isTimeout = error?.message?.includes('expired') || error?.message?.includes('timeout');

    if (isRejection) {
      await ctx.reply(
        '❌ Signature rejected again.\n\n' +
        'Send /sign to try again, or /wc to reconnect wallet.'
      );
    } else if (isTimeout) {
      await ctx.reply(
        '⏰ Signature request timed out.\n\n' +
        'Send /sign to try again, or /wc to reconnect wallet.'
      );
    } else {
      state.step = 'address';
      await ctx.reply(
        '❌ Signature failed.\n\n' +
        'Send /wc to reconnect wallet.'
      );
    }
  }
});

async function handleWcVerification(
  ctx: Context,
  userId: number,
  state: NonNullable<ReturnType<typeof verificationState.get>>
): Promise<void> {
  // Poll for session connection
  let attempts = 0;
  const maxAttempts = 60; // 5 minutes with 5-second intervals

  const checkSession = async (): Promise<void> => {
    attempts++;

    // Check if user rejected the connection
    const rejection = checkAndClearRejection(userId);
    if (rejection) {
      state.step = 'address';
      try {
        await ctx.reply(
          '❌ Connection rejected in wallet.\n\n' +
          'To try again:\n' +
          '• Send /wc for a new QR code\n' +
          '• Or send your BCH address for manual verification'
        );
      } catch (replyError) {
        console.error('Failed to send rejection reply:', replyError);
      }
      return;
    }

    const session = getUserSession(userId);
    if (session) {
      // Session connected - proceed with verification
      try {
        await ctx.reply('✅ Wallet connected! Verifying address ownership...');

        // Get addresses
        const addressInfos = await requestAddresses(userId);
        if (addressInfos.length === 0) {
          await ctx.reply('No addresses found in wallet. Please try again.');
          verificationState.delete(userId);
          return;
        }

        const address = addressInfos[0].address;

        // Check if this address is already verified for this group
        const existingForAddress = getVerificationByAddress(userId, state.groupId, address);
        if (existingForAddress) {
          // Already proved ownership of this address - just re-check conditions
          await ctx.reply('🔍 Re-checking conditions for your verified address...');
          await disconnectSession(userId);

          const rules = getAccessRules(state.groupId);
          const existingVerifications = getVerificationsForUser(userId).filter(v => v.group_id === state.groupId);
          const allAddresses = [...new Set(existingVerifications.map(v => v.bch_address))];
          const result = await checkAccessRulesMultiAddress(allAddresses, rules);

          if (result.satisfied) {
            deletePendingKick(userId, state.groupId);

            await ctx.reply(
              '✅ **All requirements now satisfied!**\n\n' +
              await formatRequirementsMessage(rules, result),
              { parse_mode: 'Markdown' }
            );
            await addUserToGroup(ctx, userId, state.groupId);
            verificationState.delete(userId);
          } else {
            // Still pending - show progress
            let msg = '📊 **Current Status:**\n\n';
            msg += await formatRequirementsMessage(rules, result);
            if (result.nftSatisfied && !result.balanceSatisfied) {
              msg += `_NFT requirement satisfied! Still need a balance condition._\n\n`;
            } else if (!result.nftSatisfied && result.balanceSatisfied) {
              msg += `_Balance requirement satisfied! Still need an NFT condition._\n\n`;
            }
            msg += `Verify another address via /wc or paste address.`;
            await ctx.reply(msg, { parse_mode: 'Markdown' });
            state.step = 'address';
          }
          return;
        }

        // Get access rules and check this address + existing verifications
        const rules2 = getAccessRules(state.groupId);
        const existingVerifications2 = getVerificationsForUser(userId).filter(v => v.group_id === state.groupId);
        const allAddresses2 = [...new Set([...existingVerifications2.map(v => v.bch_address), address])];
        const result2 = await checkAccessRulesMultiAddress(allAddresses2, rules2);

        // Store address for signature verification
        state.address = address;

        // Request signature to prove address ownership
        const challenge = createChallenge(userId, state.groupId, address);
        const challengeMessage = generateChallengeMessage(
          state.groupName,
          state.groupId,
          challenge.nonce
        );
        state.challenge = challenge;
        state.challengeMessage = challengeMessage;

        await ctx.reply('📝 Please approve the signature request in your wallet...');

        try {
          const signature = await requestSignMessage(userId, challengeMessage, address);

          // Verify signature
          const sigValid = await verifySignedMessage(challengeMessage, signature, address);
          if (!sigValid) {
            await ctx.reply('❌ Signature verification failed. Please try again with /wc');
            deleteChallenge(challenge.id);
            await disconnectSession(userId);
            verificationState.delete(userId);
            return;
          }

          // Store verification
          const username = ctx.from?.username || null;
          addVerification(userId, username, state.groupId, address);
          await addAddressToMonitor(address);
          deleteChallenge(challenge.id);
          await disconnectSession(userId);

          // Check if all requirements are met
          if (result2.satisfied) {
            deletePendingKick(userId, state.groupId);

            await ctx.reply(
              '✅ **Verification successful!**\n\n' +
              'All requirements satisfied!',
              { parse_mode: 'Markdown' }
            );

            await addUserToGroup(ctx, userId, state.groupId);
            verificationState.delete(userId);
          } else {
            // Show progress
            let msg = '✅ **Address verified!**\n\n';
            msg += `Address: \`${address.slice(0, 20)}...\`\n\n`;
            msg += '**Condition Progress:**\n\n';
            msg += await formatRequirementsMessage(rules2, result2);

            // Show what's still needed
            if (result2.nftSatisfied && !result2.balanceSatisfied) {
              msg += `_NFT requirement satisfied! Still need a balance condition._\n\n`;
            } else if (!result2.nftSatisfied && result2.balanceSatisfied) {
              msg += `_Balance requirement satisfied! Still need an NFT condition._\n\n`;
            } else {
              msg += `_Still need requirements - verify another address._\n\n`;
            }

            msg += `Prove another address via /wc or paste address, or /cancel.`;

            await ctx.reply(msg, { parse_mode: 'Markdown' });
            state.step = 'address';
          }

        } catch (error: any) {
          console.error('WC signature error:', error);
          deleteChallenge(challenge.id);

          const isRejection = error?.message?.includes('rejected') || error?.message?.includes('Rejected') || error?.code === 5000;
          if (isRejection) {
            state.step = 'wc_sign_pending';
            await ctx.reply(
              '❌ Signature rejected.\n\n' +
              'Send /sign to resend the request, or /wc to reconnect.'
            );
          } else {
            await disconnectSession(userId);
            state.step = 'address';
            await ctx.reply('❌ Signature failed. Send /wc to try again.');
          }
          return;
        }

      } catch (error: any) {
        console.error('WC verification error:', error);

        const isTimeout = error?.message?.includes('expired') || error?.message?.includes('timeout');
        const isRejection = error?.message?.includes('rejected') || error?.message?.includes('Rejected') || error?.code === 5000;

        if (isRejection) {
          // User rejected signature - keep session, allow retry with /sign
          state.step = 'wc_sign_pending';
          await ctx.reply(
            '❌ Signature rejected.\n\n' +
            'To try again:\n' +
            '• Send /sign to resend the signature request\n' +
            '• Send /wc to reconnect wallet\n' +
            '• Or send your BCH address for manual verification'
          );
        } else if (isTimeout) {
          // Timeout - disconnect and allow /wc retry
          try {
            await disconnectSession(userId);
          } catch (disconnectError) {
            // Ignore disconnect errors
          }
          state.step = 'address';
          await ctx.reply(
            '⏰ Signing request timed out.\n\n' +
            'To try again:\n' +
            '• Send /wc for a new QR code\n' +
            '• Or send your BCH address for manual verification'
          );
        } else {
          // Other error - disconnect and allow retry
          try {
            await disconnectSession(userId);
          } catch (disconnectError) {
            // Ignore disconnect errors
          }
          state.step = 'address';
          await ctx.reply(
            '❌ Verification failed.\n\n' +
            'To try again:\n' +
            '• Send /wc for a new QR code\n' +
            '• Or send your BCH address for manual verification'
          );
        }
      }
      return;
    }

    if (attempts >= maxAttempts) {
      // Keep state so user can retry with /wc
      // Note: onTimeout callback in session.ts handles the user notification
      state.step = 'address';
      return;
    }

    // Continue polling
    setTimeout(() => {
      checkSession().catch(err => console.error('checkSession error:', err));
    }, 5000);
  };

  // Start polling after a short delay
  setTimeout(() => {
    checkSession().catch(err => console.error('checkSession error:', err));
  }, 5000);
}

// Handle text messages for manual verification
verifyHandlers.on('message:text', async (ctx: Context, next) => {
  if (ctx.chat?.type !== 'private') return next();
  if (!ctx.message?.text) return next();

  const userId = ctx.from!.id;
  const state = verificationState.get(userId);
  const text = ctx.message.text.trim();

  // Ignore commands - let command handlers process them
  if (text.startsWith('/')) return next();

  if (!state) return;

  // Accept addresses during wc_waiting state (user chose manual fallback)
  if (state.step === 'wc_waiting' && isValidBchAddress(text)) {
    // Switch to manual flow
    state.step = 'address';
  }

  if (state.step === 'address') {
    // User is sending their address
    if (!isValidBchAddress(text)) {
      await ctx.reply(
        '❌ Invalid BCH address format.\n\n' +
        'Please send a valid CashAddress (starting with bitcoincash: or just the qr... part).'
      );
      return;
    }

    const address = text.startsWith('bitcoincash:') ? text : `bitcoincash:${text}`;

    // Check if this address is already verified for this group
    const existingForAddress = getVerificationByAddress(userId, state.groupId, address);
    if (existingForAddress) {
      // Already proved ownership of this address - just re-check conditions
      await ctx.reply('🔍 Re-checking conditions for your verified address...');

      const rules = getAccessRules(state.groupId);
      const existingVerifications = getVerificationsForUser(userId).filter(v => v.group_id === state.groupId);
      const allAddresses = [...new Set(existingVerifications.map(v => v.bch_address))];
      const result = await checkAccessRulesMultiAddress(allAddresses, rules);

      if (result.satisfied) {
        deletePendingKick(userId, state.groupId);

        await ctx.reply(
          '✅ **All requirements now satisfied!**\n\n' +
          await formatRequirementsMessage(rules, result),
          { parse_mode: 'Markdown' }
        );
        await addUserToGroup(ctx, userId, state.groupId);
        verificationState.delete(userId);
      } else {
        // Still pending - show progress
        let msg = '📊 **Current Status:**\n\n';
        msg += await formatRequirementsMessage(rules, result);
        if (result.nftSatisfied && !result.balanceSatisfied) {
          msg += `_NFT requirement satisfied! Still need a balance condition._\n\n`;
        } else if (!result.nftSatisfied && result.balanceSatisfied) {
          msg += `_Balance requirement satisfied! Still need an NFT condition._\n\n`;
        }
        msg += `Verify another address via /wc or paste address.`;
        await ctx.reply(msg, { parse_mode: 'Markdown' });
      }
      return;
    }

    // Check access rules
    await ctx.reply('🔍 Checking wallet...');

    try {
      const rules = getAccessRules(state.groupId);
      const existingVerifications = getVerificationsForUser(userId).filter(v => v.group_id === state.groupId);
      const allAddresses = [...new Set([...existingVerifications.map(v => v.bch_address), address])];
      const result = await checkAccessRulesMultiAddress(allAddresses, rules);

      // Find matching NFT if any
      const nftMatch = result.nftResults.find(r => r.satisfied && r.matchingNft);
      const nft = nftMatch?.matchingNft;

      // Create challenge for signature verification
      const challenge = createChallenge(userId, state.groupId, address);
      const challengeMessage = generateChallengeMessage(
        state.groupName,
        state.groupId,
        challenge.nonce
      );

      state.step = 'signature';
      state.challenge = challenge;
      state.challengeMessage = challengeMessage;
      state.address = address;

      let msg = '';
      if (result.satisfied) {
        msg = `✅ **Requirements satisfied!**\n\n`;
      } else if (nft) {
        const nftMetadata = await fetchTokenMetadata(nft.category);
        const nftDisplay = formatNftDisplay(nft.category, nft.commitment, nftMetadata);
        msg = `✅ NFT found: ${nftDisplay}\n\n`;
        msg += `_Some requirements still not met - you can add more addresses after._\n\n`;
      } else {
        msg = `⏳ No qualifying NFTs found at this address yet.\n\n`;
        msg += `You can still verify now. I'll monitor your address and grant access when requirements are met.\n\n`;
      }

      msg += `**Sign this message in your wallet:**\n\n`;
      msg += `\`\`\`\n${challengeMessage}\n\`\`\`\n\n`;
      msg += `In Electron Cash: Tools → Sign/verify message\n\n`;
      msg += `Then paste the **signature** here (base64 text).`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });

    } catch (error) {
      console.error('Wallet check error:', error);
      await ctx.reply('❌ Error checking wallet. Please try again later.');
    }

  } else if (state.step === 'signature') {
    // User is sending their signature
    const signature = text.replace(/\s+/g, ''); // Remove whitespace

    if (!state.challenge || !state.address || !state.challengeMessage) {
      await ctx.reply('Session expired. Please start over with /verify');
      verificationState.delete(userId);
      return;
    }

    // Verify signature using stored challenge message
    const sigValid = await verifySignedMessage(state.challengeMessage, signature, state.address);

    if (!sigValid) {
      await ctx.reply(
        '❌ Signature verification failed.\n\n' +
        'Make sure you:\n' +
        '1. Signed the exact message shown above\n' +
        '2. Used the correct address\n' +
        '3. Copied the full signature\n\n' +
        'Try again by pasting the signature.'
      );
      return;
    }

    // Re-check access rules to determine status
    const rules = getAccessRules(state.groupId);
    const existingVerifications = getVerificationsForUser(userId).filter(v => v.group_id === state.groupId);
    const allAddresses = [...new Set([...existingVerifications.map(v => v.bch_address), state.address])];
    const result = await checkAccessRulesMultiAddress(allAddresses, rules);

    // Store verification
    const username = ctx.from?.username || null;
    addVerification(userId, username, state.groupId, state.address);
    await addAddressToMonitor(state.address);
    deleteChallenge(state.challenge.id);

    if (result.satisfied) {
      // All requirements met!
      deletePendingKick(userId, state.groupId);

      await ctx.reply(
        '✅ **Verification successful!**\n\n' +
        'All requirements satisfied!',
        { parse_mode: 'Markdown' }
      );

      await addUserToGroup(ctx, userId, state.groupId);
      verificationState.delete(userId);
    } else {
      // Show progress
      let msg = '✅ **Address verified!**\n\n';
      msg += `Address: \`${state.address.slice(0, 20)}...\`\n\n`;
      msg += '**Condition Progress:**\n\n';
      msg += await formatRequirementsMessage(rules, result);

      if (result.nftSatisfied && !result.balanceSatisfied) {
        msg += `_NFT requirement satisfied! Still need a balance condition._\n\n`;
      } else if (!result.nftSatisfied && result.balanceSatisfied) {
        msg += `_Balance requirement satisfied! Still need an NFT condition._\n\n`;
      } else {
        msg += `_I'll monitor your address and grant access when requirements are met._\n\n`;
      }

      msg += `You can verify another address via /wc or paste address, or /cancel.`;

      await ctx.reply(msg, { parse_mode: 'Markdown' });
      state.step = 'address'; // Allow adding more addresses
    }
  }
});

// /list_verifications - Show all user's verifications
verifyHandlers.command('list_verifications', async (ctx: Context) => {
  console.log('/list_verifications command received');
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Please use this command in a private chat with me.');
    return;
  }

  const userId = ctx.from!.id;
  const verifications = getVerificationsForUser(userId);

  if (verifications.length === 0) {
    await ctx.reply('You have no verifications.');
    return;
  }

  let msg = '📋 **Your verifications:**\n\n';

  for (const v of verifications) {
    const group = getGroup(v.group_id);
    const groupName = group?.name || `Group ${v.group_id}`;
    const addressShort = v.bch_address.slice(0, 25) + '...';

    msg += `**[${v.id}]**: ${groupName}\n`;
    msg += `    📍 ${addressShort}\n\n`;
  }

  msg += `\nUse \`/unverify <id>\` to remove a verification.`;

  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// /status - Show condition fulfillment status for user
verifyHandlers.command('status', async (ctx: Context) => {
  const userId = ctx.from!.id;
  const chatType = ctx.chat?.type;
  const chatId = ctx.chat?.id;

  if (chatType === 'private') {
    // DM: Show status for all groups user has verifications for
    const verifications = getVerificationsForUser(userId);

    if (verifications.length === 0) {
      await ctx.reply(
        'You have no verifications yet.\n\n' +
        'Join a gated group or use /verify to get started.'
      );
      return;
    }

    // Get unique groups
    const groupIds = [...new Set(verifications.map(v => v.group_id))];

    let msg = '📊 **Your verification status:**\n\n';

    for (const groupId of groupIds) {
      const group = getGroup(groupId);
      const groupName = group?.name || `Group ${groupId}`;
      const rules = getAccessRules(groupId);

      msg += `**${groupName}**\n`;

      if (rules.length === 0) {
        msg += `_No conditions configured_\n\n`;
        continue;
      }

      // Get user's addresses for this group
      const userAddresses = verifications
        .filter(v => v.group_id === groupId)
        .map(v => v.bch_address);

      const result = await checkAccessRulesMultiAddress(userAddresses, rules);

      msg += await formatRequirementsMessage(rules, result);

      if (result.satisfied) {
        msg += `✅ _Access granted_\n\n`;
      } else {
        msg += `⏳ _Requirements not met_\n\n`;
      }
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  } else {
    // In group: Show status for this group via DM
    if (!chatId) return;

    // Delete the command message from the group
    try {
      await ctx.deleteMessage();
    } catch {
      // May fail if bot lacks delete permission or message is old
    }

    const rules = getAccessRules(chatId);

    if (rules.length === 0) {
      try {
        await ctx.api.sendMessage(userId, 'This group has no access conditions configured.');
      } catch {
        await ctx.reply('Please start a DM with me first, then try again.');
      }
      return;
    }

    const verifications = getVerificationsForUser(userId).filter(v => v.group_id === chatId);
    const group = getGroup(chatId);
    const groupName = group?.name || 'This group';

    let msg = `📊 **${groupName} status:**\n\n`;

    if (verifications.length === 0) {
      // User has no verifications for this group
      msg += await formatRequirementsMessage(rules, null);
      msg += `\n_You have no verified addresses for this group._\n`;
      msg += `_Use /verify to verify your wallet._`;
    } else {
      const userAddresses = verifications.map(v => v.bch_address);
      const result = await checkAccessRulesMultiAddress(userAddresses, rules);

      msg += await formatRequirementsMessage(rules, result);

      if (result.satisfied) {
        msg += `✅ _Access granted_`;
      } else {
        msg += `⏳ _Requirements not met_`;
      }
    }

    try {
      await ctx.api.sendMessage(userId, msg, { parse_mode: 'Markdown' });
    } catch {
      await ctx.reply('Please start a DM with me first, then try again.');
    }
  }
});

// /unverify - Remove a verification
verifyHandlers.command('unverify', async (ctx: Context) => {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Please use this command in a private chat with me.');
    return;
  }

  const userId = ctx.from!.id;
  const args = (ctx.match as string || '').trim();

  if (!args) {
    await ctx.reply(
      'Usage: `/unverify <id>`\n\n' +
      'Use `/list_verifications` to see your verification IDs.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const verificationId = parseInt(args, 10);
  if (isNaN(verificationId)) {
    await ctx.reply('Invalid verification ID. Use `/list_verifications` to see your IDs.', { parse_mode: 'Markdown' });
    return;
  }

  // Get the verification and verify ownership
  const verification = getVerificationById(verificationId);
  if (!verification) {
    await ctx.reply('Verification not found.');
    return;
  }

  if (verification.telegram_user_id !== userId) {
    await ctx.reply('This verification does not belong to you.');
    return;
  }

  const group = getGroup(verification.group_id);
  const groupName = group?.name || `Group ${verification.group_id}`;
  const groupId = verification.group_id;
  const address = verification.bch_address;

  // Delete the verification
  deleteVerification(verificationId);

  // Check if any other verifications use this address
  const otherVerifications = getVerificationsByAddress(address);
  if (otherVerifications.length === 0) {
    // No other verifications use this address - stop monitoring
    removeAddressFromMonitor(address);
  }

  // Check if user still qualifies for the group with remaining verifications
  const remainingVerifications = getVerificationsForMonitoring().filter(
    v => v.telegram_user_id === userId && v.group_id === groupId
  );

  let restrictedMsg = '';
  if (remainingVerifications.length > 0) {
    // User has other verifications - check if they still qualify
    const rules = getAccessRules(groupId);
    if (rules.length > 0) {
      const addresses = [...new Set(remainingVerifications.map(v => v.bch_address))];
      const result = await checkAccessRulesMultiAddress(addresses, rules);

      if (!result.satisfied) {
        // User no longer qualifies - restrict them
        try {
          await ctx.api.restrictChatMember(groupId, userId, {
            can_send_messages: false
          });
          // Add pending kick to track restricted status
          addPendingKick(userId, groupId);
          restrictedMsg = `\n\n⚠️ You no longer meet the access conditions for this group and have been restricted.`;
        } catch (e) {
          // May fail if bot doesn't have permission or user left
        }
      }
    }
  } else {
    // No more verifications for this group - restrict user
    try {
      await ctx.api.restrictChatMember(groupId, userId, {
        can_send_messages: false
      });
      // Add pending kick to prevent group message spam
      addPendingKick(userId, groupId);
      restrictedMsg = `\n\n⚠️ You no longer have any verified addresses for this group and have been restricted. Use /verify (or leave and re-join the group) to verify.`;
    } catch (e) {
      // May fail if bot doesn't have permission or user left
    }
  }

  await ctx.reply(
    `✅ Verification removed:\n\n` +
    `Group: ${groupName}\n` +
    `Address: ${address.slice(0, 25)}...` +
    restrictedMsg
  );
});

// /cancel - Cancel verification
verifyHandlers.command('cancel', async (ctx: Context) => {
  if (ctx.chat?.type !== 'private') return;

  const userId = ctx.from!.id;
  const state = verificationState.get(userId);

  if (state) {
    if (state.challenge) {
      deleteChallenge(state.challenge.id);
    }
    verificationState.delete(userId);
    await ctx.reply('Verification cancelled.');
  } else {
    await ctx.reply('No active verification to cancel.');
  }
});

async function addUserToGroup(
  ctx: Context,
  userId: number,
  groupId: number
): Promise<void> {
  console.log(`[addUserToGroup] Unrestricting user ${userId} in group ${groupId}`);
  try {
    // Get pending kick info before deleting (we need the prompt_message_id)
    const pendingKick = getPendingKick(userId, groupId);

    await unrestrictUser(ctx.api, groupId, userId);
    console.log(`[addUserToGroup] Successfully unrestricted user ${userId}`);

    // Delete the verification prompt message from the group if we have the message ID
    if (pendingKick?.prompt_message_id) {
      try {
        await ctx.api.deleteMessage(groupId, pendingKick.prompt_message_id);
      } catch {
        // Message may have already been deleted or too old
      }
    }

    // Send "verified" message to the group
    const username = ctx.from?.username
      ? `@${ctx.from.username}`
      : ctx.from?.first_name || 'User';

    try {
      await sendVerifiedMessage(ctx.api, groupId, username);
    } catch {
      // May fail if bot can't send to the group
    }

    // Try to get a link to the group for the DM
    let groupLink = '';
    try {
      const chat = await ctx.api.getChat(groupId);
      if ('username' in chat && chat.username) {
        groupLink = `\n\nGo to group: https://t.me/${chat.username}`;
      } else if ('invite_link' in chat && chat.invite_link) {
        groupLink = `\n\nGo to group: ${chat.invite_link}`;
      }
    } catch {
      // Ignore errors getting chat info
    }

    await ctx.reply(`✅ You now have full access to the group!${groupLink}`);
  } catch (error: any) {
    console.error(`[addUserToGroup] Error unrestricting user ${userId}:`, error.message);
    await ctx.reply(
      'Verification complete, but I couldn\'t update your permissions. Please ask a group admin.'
    );
  }
}

// Check group messages for unverified members (prompt once per user)
verifyHandlers.on('message', async (ctx: Context, next) => {
  // Only handle group messages
  if (ctx.chat?.type === 'private') {
    return next();
  }

  const userId = ctx.from?.id;
  if (!userId) return next();

  const chatId = ctx.chat!.id;

  // Check if this group is configured for NFT gating
  if (!isGroupConfigured(chatId)) {
    return next();
  }

  // Check if user is already verified
  const verification = getVerification(userId, chatId);
  if (verification) {
    return next();
  }

  // Check if we've already prompted this user (they're in pending_kicks)
  const pending = getPendingKick(userId, chatId);
  if (pending) {
    return next();
  }

  // Check if user is admin (don't prompt admins)
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    if (member.status === 'administrator' || member.status === 'creator') {
      return next();
    }
  } catch {
    // If we can't check, continue anyway
  }

  // First message from unverified member - prompt them once
  addPendingKick(userId, chatId);

  const botUsername = ctx.me.username;
  const deepLink = `https://t.me/${botUsername}?start=verify_${chatId}`;
  const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || 'there';

  await ctx.reply(
    `👋 Hey ${username}! This group requires NFT verification.\n\n` +
    `Click here to verify: ${deepLink}`
  );

  return next();
});
