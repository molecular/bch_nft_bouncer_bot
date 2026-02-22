import { SignClient } from '@walletconnect/sign-client';
import { config } from '../config.js';

let signClient: SignClient | null = null;

// Active sessions mapped by Telegram user ID
const userSessions: Map<number, {
  topic: string;
  pairingTopic: string;
  addresses: string[];
}> = new Map();

// Pending pairings waiting for wallet connection
const pendingPairings: Map<string, {
  telegramUserId: number;
  groupId: number;
  resolve: (session: any) => void;
  reject: (error: Error) => void;
}> = new Map();

// Track rejected pairings so polling can detect them
const rejectedPairings: Map<number, { message: string; code: number }> = new Map();

export async function initWalletConnect(): Promise<SignClient> {
  if (signClient) {
    return signClient;
  }

  if (!config.wcProjectId) {
    throw new Error('WalletConnect Project ID not configured');
  }

  signClient = await SignClient.init({
    projectId: config.wcProjectId,
    metadata: {
      name: 'NFT Entry Bot',
      description: 'Telegram bot for NFT-gated group access',
      url: 'https://github.com/nft-entry-bot',
      icons: ['https://avatars.githubusercontent.com/u/37784886'], // BCH logo
    },
  });

  // Handle session events
  signClient.on('session_event', (event) => {
    console.log('WC session event:', event);
  });

  signClient.on('session_update', ({ topic, params }) => {
    console.log('WC session update:', topic, params);
  });

  signClient.on('session_delete', ({ topic }) => {
    console.log('WC session deleted:', topic);
    // Remove from our tracking
    for (const [userId, session] of userSessions.entries()) {
      if (session.topic === topic) {
        userSessions.delete(userId);
        break;
      }
    }
  });

  console.log('WalletConnect initialized');
  return signClient;
}

export async function getSignClient(): Promise<SignClient> {
  if (!signClient) {
    return initWalletConnect();
  }
  return signClient;
}

export interface PairingResult {
  uri: string;
  pairingTopic: string;
}

/**
 * Create a new pairing for a user to connect their wallet
 */
export async function createPairing(
  telegramUserId: number,
  groupId: number
): Promise<PairingResult> {
  const client = await getSignClient();

  // BCH namespace according to wc2-bch-bcr spec
  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      bch: {
        methods: ['bch_getAddresses', 'bch_signMessage', 'bch_signTransaction'],
        chains: ['bch:bitcoincash'],
        events: ['addressesChanged'],
      },
    },
  });

  if (!uri) {
    throw new Error('Failed to generate WalletConnect URI');
  }

  // Extract pairing topic from URI
  const pairingTopic = uri.split('@')[0].split(':')[1];

  // Store pending pairing
  const pairingPromise = new Promise<any>((resolve, reject) => {
    pendingPairings.set(pairingTopic, {
      telegramUserId,
      groupId,
      resolve,
      reject,
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (pendingPairings.has(pairingTopic)) {
        pendingPairings.delete(pairingTopic);
        reject(new Error('Pairing timeout'));
      }
    }, 5 * 60 * 1000);
  });

  // Handle approval asynchronously
  approval().then((session) => {
    const pending = pendingPairings.get(pairingTopic);
    if (pending) {
      pendingPairings.delete(pairingTopic);

      // Store session for user
      userSessions.set(pending.telegramUserId, {
        topic: session.topic,
        pairingTopic,
        addresses: [],
      });

      pending.resolve(session);
    }
  }).catch((error) => {
    const pending = pendingPairings.get(pairingTopic);
    if (pending) {
      pendingPairings.delete(pairingTopic);
      // Store rejection so polling can detect it
      rejectedPairings.set(pending.telegramUserId, {
        message: error?.message || 'Connection rejected',
        code: error?.code || 0,
      });
    }
  });

  return { uri, pairingTopic };
}

/**
 * Wait for a pairing to be approved
 */
export async function waitForPairing(pairingTopic: string): Promise<any> {
  const pending = pendingPairings.get(pairingTopic);
  if (!pending) {
    throw new Error('No pending pairing found');
  }

  return new Promise((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
  });
}

/**
 * Get user's session if connected
 */
export function getUserSession(telegramUserId: number): {
  topic: string;
  pairingTopic: string;
  addresses: string[];
} | undefined {
  return userSessions.get(telegramUserId);
}

/**
 * Check if user rejected the connection and clear the rejection
 */
export function checkAndClearRejection(telegramUserId: number): { message: string; code: number } | undefined {
  const rejection = rejectedPairings.get(telegramUserId);
  if (rejection) {
    rejectedPairings.delete(telegramUserId);
  }
  return rejection;
}

/**
 * Set user's addresses after bch_getAddresses call
 */
export function setUserAddresses(telegramUserId: number, addresses: string[]): void {
  const session = userSessions.get(telegramUserId);
  if (session) {
    session.addresses = addresses;
  }
}

/**
 * Disconnect a user's session
 */
export async function disconnectSession(telegramUserId: number): Promise<void> {
  const session = userSessions.get(telegramUserId);
  if (!session) return;

  const client = await getSignClient();
  try {
    await client.disconnect({
      topic: session.topic,
      reason: { code: 6000, message: 'User disconnected' },
    });
  } catch (error) {
    console.error('Error disconnecting session:', error);
  }

  userSessions.delete(telegramUserId);
}

/**
 * Close WalletConnect client
 */
export async function closeWalletConnect(): Promise<void> {
  // Disconnect all sessions
  for (const [userId] of userSessions) {
    await disconnectSession(userId);
  }

  signClient = null;
}
