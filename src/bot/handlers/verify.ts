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
  getVerificationByNft,
  getNftCategories,
  getGroup,
  isGroupConfigured,
} from '../../storage/queries.js';
import { checkNftOwnership, isValidCategoryId } from '../../blockchain/nft.js';
import { verifySignedMessage, generateChallengeMessage, isValidBchAddress } from '../../blockchain/verify.js';
import { createPairing, getUserSession, disconnectSession, checkAndClearRejection } from '../../walletconnect/session.js';
import { generateQRBuffer } from '../../walletconnect/qr.js';
import { requestAddresses, requestSignMessage } from '../../walletconnect/sign.js';
import { config } from '../../config.js';

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
  wcNft?: { category: string; commitment: string | null };
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
    let msg = `👋 Welcome! You need to verify NFT ownership to join the following group(s):\n\n`;

    for (const pk of pendingKicks) {
      const group = getGroup(pk.group_id);
      msg += `• ${group?.name || `Group ${pk.group_id}`}\n`;
    }

    msg += `\nUse /verify to start the verification process.`;

    await ctx.reply(msg);
  } else {
    await ctx.reply(
      `👋 Welcome to the NFT Entry Bot!\n\n` +
      `I help Telegram groups restrict access to NFT holders.\n\n` +
      `**For users:**\n` +
      `• When you join a gated group, you'll be asked to verify NFT ownership\n` +
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
      `🔐 To verify NFT ownership, click here:\n${deepLink}`,
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
    await ctx.reply('This group is no longer configured for NFT verification.');
    return;
  }

  const categories = getNftCategories(groupId);
  if (categories.length === 0) {
    await ctx.reply('This group has no NFT categories configured. Contact the group admin.');
    return;
  }

  // Check if already verified
  const existing = getVerification(userId, groupId);
  if (existing) {
    await ctx.reply(
      `You're already verified for this group!\n\n` +
      `If you're having trouble joining, contact the group admin.`
    );
    return;
  }

  // Store state
  verificationState.set(userId, {
    step: 'address',
    groupId,
    groupName: group.name || `Group ${groupId}`,
  });

  // Offer both verification methods
  let msg = `🔐 **Verification for ${group.name}**\n\n`;
  msg += `To verify, I need to confirm you own an NFT from one of these categories:\n`;
  categories.forEach(cat => {
    msg += `• \`${cat.slice(0, 16)}...${cat.slice(-8)}\`\n`;
  });

  msg += `\n**Choose verification method:**\n\n`;
  msg += `1️⃣ **WalletConnect** (recommended)\n`;
  msg += `   Send /wc to connect your wallet via QR code\n\n`;
  msg += `2️⃣ **Manual Signature**\n`;
  msg += `   Send your BCH address that holds the NFT\n`;
  msg += `   Example: \`bitcoincash:qr...\``;

  await ctx.reply(msg, { parse_mode: 'Markdown' });
}

// /wc - Start WalletConnect flow
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

  await ctx.reply('🔄 Generating WalletConnect QR code...');

  try {
    // Disconnect any existing session and clear any pending rejection
    await disconnectSession(userId);
    checkAndClearRejection(userId);

    const { uri, pairingTopic } = await createPairing(userId, state.groupId);

    // Generate QR code
    const qrBuffer = await generateQRBuffer(uri);

    // Update state
    state.step = 'wc_waiting';
    state.wcPairingTopic = pairingTopic;

    // Send QR code
    await ctx.replyWithPhoto(new InputFile(qrBuffer, 'walletconnect.png'), {
      caption:
        '📱 **Scan with your BCH wallet that supports WalletConnect**\n\n' +
        'After connecting, I\'ll let you sign a message with the key that owns the NFT.',
      parse_mode: 'Markdown',
    });

    // Also send the URI for copy-paste
    await ctx.reply(
      `Or copy this link to your wallet:\n\n\`${uri}\``,
      { parse_mode: 'Markdown' }
    );

    // Wait for connection and handle verification
    handleWcVerification(ctx, userId, state);

  } catch (error) {
    console.error('WalletConnect error:', error);
    await ctx.reply(
      'Failed to start WalletConnect. Please try manual verification by sending your BCH address.'
    );
  }
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

  if (!state.address || !state.wcNft || !state.challengeMessage) {
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

    // Success! Store verification
    const username = ctx.from?.username || null;
    addVerification(userId, username, state.groupId, state.wcNft.category, state.wcNft.commitment, state.address);
    if (state.challenge) {
      deleteChallenge(state.challenge.id);
    }
    deletePendingKick(userId, state.groupId);

    await ctx.reply(
      '✅ **Verification successful!**\n\n' +
      `NFT: \`${state.wcNft.category.slice(0, 16)}...${state.wcNft.commitment ? ` (${state.wcNft.commitment.slice(0, 8)}...)` : ''}\`\n\n` +
      'You now have full access to the group!',
      { parse_mode: 'Markdown' }
    );

    // Try to add user back to group
    await addUserToGroup(ctx, userId, state.groupId);

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
        await ctx.reply('✅ Wallet connected! Verifying NFT ownership...');

        // Get addresses
        const addressInfos = await requestAddresses(userId);
        if (addressInfos.length === 0) {
          await ctx.reply('No addresses found in wallet. Please try again.');
          verificationState.delete(userId);
          return;
        }

        const address = addressInfos[0].address;

        // Check NFT ownership
        const categories = getNftCategories(state.groupId);
        const ownedNfts = await checkNftOwnership(address, categories);

        if (ownedNfts.length === 0) {
          await ctx.reply(
            '❌ No qualifying NFTs found in your wallet.\n\n' +
            'Make sure your wallet contains an NFT from one of the required categories.'
          );
          await disconnectSession(userId);
          verificationState.delete(userId);
          return;
        }

        const nft = ownedNfts[0];

        // Check if this NFT is already bound to another user
        const existingBinding = getVerificationByNft(nft.category, nft.commitment);
        if (existingBinding && existingBinding.telegram_user_id !== userId) {
          await ctx.reply(
            '❌ This NFT is already verified by another user.\n\n' +
            'Each NFT can only verify one Telegram account.'
          );
          await disconnectSession(userId);
          verificationState.delete(userId);
          return;
        }

        // Store address and NFT for potential retry
        state.address = address;
        state.wcNft = { category: nft.category, commitment: nft.commitment };

        // Request signature for additional verification
        const challenge = createChallenge(userId, state.groupId, address);
        const challengeMessage = generateChallengeMessage(
          state.groupName,
          state.groupId,
          challenge.nonce
        );
        state.challenge = challenge;
        state.challengeMessage = challengeMessage;

        await ctx.reply(
          '📝 Please approve the signature request in your wallet to complete verification...'
        );

        const signature = await requestSignMessage(userId, challengeMessage, address);

        // Verify signature
        const sigValid = await verifySignedMessage(challengeMessage, signature, address);
        if (!sigValid) {
          await ctx.reply('❌ Signature verification failed. Please try again.');
          deleteChallenge(challenge.id);
          await disconnectSession(userId);
          verificationState.delete(userId);
          return;
        }

        // Success! Store verification
        const username = ctx.from?.username || null;
        addVerification(userId, username, state.groupId, nft.category, nft.commitment, address);
        deleteChallenge(challenge.id);
        deletePendingKick(userId, state.groupId);

        await ctx.reply(
          '✅ **Verification successful!**\n\n' +
          `NFT: \`${nft.category.slice(0, 16)}...${nft.commitment ? ` (${nft.commitment.slice(0, 8)}...)` : ''}\`\n\n` +
          'You can now rejoin the group. Use this link:',
          { parse_mode: 'Markdown' }
        );

        // Try to add user back to group
        await addUserToGroup(ctx, userId, state.groupId);

        await disconnectSession(userId);
        verificationState.delete(userId);

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
      state.step = 'address';
      await ctx.reply(
        '⏰ WalletConnect connection timed out (no wallet connected).\n\n' +
        'To try again:\n' +
        '• Send /wc for a new QR code\n' +
        '• Or send your BCH address for manual verification'
      );
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
verifyHandlers.on('message:text', async (ctx: Context) => {
  if (ctx.chat?.type !== 'private') return;
  if (!ctx.message?.text) return;

  const userId = ctx.from!.id;
  const state = verificationState.get(userId);
  const text = ctx.message.text.trim();

  // Ignore commands
  if (text.startsWith('/')) return;

  if (!state) return;

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

    // Check NFT ownership
    await ctx.reply('🔍 Checking NFT ownership...');

    try {
      const categories = getNftCategories(state.groupId);
      const ownedNfts = await checkNftOwnership(address, categories);

      if (ownedNfts.length === 0) {
        await ctx.reply(
          '❌ No qualifying NFTs found at this address.\n\n' +
          'Make sure this address contains an NFT from one of the required categories, ' +
          'then send the address again.'
        );
        return;
      }

      const nft = ownedNfts[0];

      // Check if this NFT is already bound
      const existingBinding = getVerificationByNft(nft.category, nft.commitment);
      if (existingBinding && existingBinding.telegram_user_id !== userId) {
        await ctx.reply(
          '❌ This NFT is already verified by another user.\n\n' +
          'Each NFT can only verify one Telegram account.'
        );
        return;
      }

      // Create challenge
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

      await ctx.reply(
        `✅ NFT found! Now I need to verify you own this address.\n\n` +
        `**Sign this message in your wallet:**\n\n` +
        `\`\`\`\n${challengeMessage}\n\`\`\`\n\n` +
        `In Electron Cash: Tools → Sign/verify message\n\n` +
        `Then paste the **signature** here (base64 text).`,
        { parse_mode: 'Markdown' }
      );

    } catch (error) {
      console.error('NFT check error:', error);
      await ctx.reply('❌ Error checking NFT ownership. Please try again later.');
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

    // Get the NFT info again
    const categories = getNftCategories(state.groupId);
    const ownedNfts = await checkNftOwnership(state.address, categories);

    if (ownedNfts.length === 0) {
      await ctx.reply('❌ NFT no longer found at this address. Please start over with /verify');
      deleteChallenge(state.challenge.id);
      verificationState.delete(userId);
      return;
    }

    const nft = ownedNfts[0];

    // Store verification
    const username = ctx.from?.username || null;
    addVerification(userId, username, state.groupId, nft.category, nft.commitment, state.address);
    deleteChallenge(state.challenge.id);
    deletePendingKick(userId, state.groupId);

    await ctx.reply(
      '✅ **Verification successful!**\n\n' +
      `Address: \`${state.address.slice(12, 28)}...\`\n` +
      `NFT: \`${nft.category.slice(0, 16)}...${nft.commitment ? ` (${nft.commitment.slice(0, 8)}...)` : ''}\`\n\n` +
      'You can now rejoin the group!',
      { parse_mode: 'Markdown' }
    );

    // Try to add user back to group
    await addUserToGroup(ctx, userId, state.groupId);

    verificationState.delete(userId);
  }
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

async function addUserToGroup(ctx: Context, userId: number, groupId: number): Promise<void> {
  console.log(`[addUserToGroup] Unrestricting user ${userId} in group ${groupId}`);
  try {
    // Unrestrict user - restore full permissions (all ChatPermissions fields)
    await ctx.api.restrictChatMember(groupId, userId, {
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

    console.log(`[addUserToGroup] Successfully unrestricted user ${userId}`);
    await ctx.reply(
      `✅ You now have full access to the group!`
    );
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
