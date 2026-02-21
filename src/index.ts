import { config, validateConfig } from './config.js';
import { initializeDatabase, closeDatabase } from './storage/db.js';
import { cleanupExpiredChallenges } from './storage/queries.js';
import { createBot } from './bot/bot.js';
import { startMonitoring, stopMonitoring } from './blockchain/monitor.js';
import { initWalletConnect, closeWalletConnect } from './walletconnect/session.js';

async function main(): Promise<void> {
  console.log('🚀 Starting NFT Entry Bot...');

  // Validate config
  try {
    validateConfig();
  } catch (error) {
    console.error('Configuration error:', error);
    process.exit(1);
  }

  // Initialize database
  initializeDatabase();

  // Clean up expired challenges
  cleanupExpiredChallenges();

  // Initialize WalletConnect if configured
  if (config.wcProjectId) {
    try {
      await initWalletConnect();
      console.log('✅ WalletConnect initialized');
    } catch (error) {
      console.error('WalletConnect initialization failed (continuing without it):', error);
    }
  } else {
    console.log('ℹ️  WalletConnect not configured (WC_PROJECT_ID not set)');
  }

  // Create and start bot
  const bot = createBot();

  // Start NFT transfer monitoring
  startMonitoring(bot);
  console.log('✅ NFT monitoring started');

  // Periodic cleanup of expired challenges
  setInterval(() => {
    cleanupExpiredChallenges();
  }, 60 * 60 * 1000); // Every hour

  // Handle shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down...`);

    stopMonitoring();
    await closeWalletConnect();
    closeDatabase();

    await bot.stop();
    console.log('Bot stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start polling
  console.log('✅ Bot starting...');

  await bot.api.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'Show help' },
    { command: 'verify', description: 'Verify NFT ownership' },
  ]);

  await bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Bot @${botInfo.username} is running!`);
    },
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
