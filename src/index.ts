// Polyfills must be imported first
import './polyfills.js';

import { config, validateConfig } from './config.js';
import { initializeDatabase, closeDatabase } from './storage/db.js';
import { cleanupExpiredChallenges } from './storage/queries.js';
import { createBot } from './bot/bot.js';
import { startMonitoring, stopMonitoring } from './blockchain/monitor.js';
import { initWalletConnect, closeWalletConnect } from './walletconnect/session.js';
import { checkMembershipTimeouts } from './bot/timeouts.js';
import { log, initLogging } from './utils/log.js';

async function main(): Promise<void> {
  log('startup', 'Starting NFT Entry Bot...');

  // Validate config
  try {
    validateConfig();
  } catch (error) {
    log('startup', `Configuration error: ${error}`);
    process.exit(1);
  }

  // Initialize database
  initializeDatabase();

  // Initialize logging (load username cache from DB)
  initLogging();

  // Clean up expired challenges
  cleanupExpiredChallenges();

  // Initialize WalletConnect if configured
  if (config.wcProjectId) {
    try {
      await initWalletConnect();
      log('startup', 'WalletConnect initialized');
    } catch (error) {
      log('startup', `WalletConnect initialization failed (continuing without it): ${error}`);
    }
  } else {
    log('startup', 'WalletConnect not configured (WC_PROJECT_ID not set)');
  }

  // Create and start bot
  const bot = createBot();

  // Start NFT transfer monitoring (with address subscriptions)
  await startMonitoring(bot);
  log('startup', 'NFT monitoring started');

  // Periodic cleanup of expired challenges
  setInterval(() => {
    cleanupExpiredChallenges();
  }, 60 * 60 * 1000); // Every hour

  // Check for membership timeouts every 2 minutes
  setInterval(() => {
    checkMembershipTimeouts(bot);
  }, 2 * 60 * 1000);

  // Periodic alive indicator (every 6 hours)
  setInterval(() => {
    log('heartbeat', 'Bot is alive');
  }, 6 * 60 * 60 * 1000);

  // Handle shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log('startup', `${signal} received, shutting down...`);

    stopMonitoring();
    await closeWalletConnect();
    closeDatabase();

    await bot.stop();
    log('startup', 'Bot stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught promise rejections (e.g., WalletConnect timeouts)
  process.on('unhandledRejection', (reason, promise) => {
    log('error', `Unhandled rejection: ${reason}`);
    // Don't crash - just log it
  });

  // Start polling
  log('startup', 'Bot starting...');

  await bot.api.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'Show help' },
    { command: 'verify', description: 'Verify your wallet' },
    { command: 'list_verifications', description: 'List your verifications' },
    { command: 'unverify', description: 'Remove a verification' },
    { command: 'cancel', description: 'Cancel current verification' },
  ]);

  await bot.start({
    allowed_updates: ['message', 'chat_member', 'my_chat_member'],
    onStart: (botInfo) => {
      log('startup', `Bot @${botInfo.username} is running!`);
    },
  });
}

main().catch((error) => {
  log('startup', `Fatal error: ${error}`);
  process.exit(1);
});
