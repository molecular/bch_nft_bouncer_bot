import 'dotenv/config';

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  wcProjectId: process.env.WC_PROJECT_ID || '',
  electrumServer: process.env.ELECTRUM_SERVER || '',
  dbPath: process.env.DB_PATH || './data/bot.db',
  challengeExpiryMinutes: 10,
};

export function validateConfig(): void {
  if (!config.botToken) {
    throw new Error('BOT_TOKEN environment variable is required');
  }
}
