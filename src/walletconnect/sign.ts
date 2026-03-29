import { getSignClient, getUserSession, setUserAddresses } from './session.js';
import { log } from '../utils/log.js';

export interface BchAddressInfo {
  address: string;
  tokenAddress?: string;
}

/**
 * Request addresses from connected wallet using bch_getAddresses
 */
export async function requestAddresses(telegramUserId: number): Promise<BchAddressInfo[]> {
  const session = getUserSession(telegramUserId);
  if (!session) {
    throw new Error('No active WalletConnect session');
  }

  const client = await getSignClient();

  try {
    const result = await client.request<BchAddressInfo[] | Record<string, unknown>>({
      topic: session.topic,
      chainId: 'bch:bitcoincash',
      request: {
        method: 'bch_getAddresses',
        params: {},
      },
    });

    log('WC', `bch_getAddresses raw result: ${JSON.stringify(result, null, 2)}`, telegramUserId);

    // Handle different response formats
    let addresses: string[] = [];

    if (Array.isArray(result)) {
      if (result.length > 0) {
        if (typeof result[0] === 'string') {
          // Format: ["bitcoincash:qp..."]
          addresses = result as unknown as string[];
        } else if (typeof result[0] === 'object' && result[0].address) {
          // Format: [{ address: "bitcoincash:qp..." }]
          addresses = (result as BchAddressInfo[]).map(a => a.address);
        }
      }
    } else if (typeof result === 'object' && result !== null) {
      const addr = (result as Record<string, unknown>).address as string;
      if (addr) {
        addresses = [addr];
      }
    }

    addresses = addresses.filter(Boolean);
    log('WC', `Parsed addresses: ${addresses.join(', ')}`, telegramUserId);
    setUserAddresses(telegramUserId, addresses);

    // Return in expected format
    return addresses.map(addr => ({ address: addr }));
  } catch (error) {
    log('WC', `error requesting addresses: ${error}`, telegramUserId);
    throw error;
  }
}

/**
 * Request a message signature from connected wallet using bch_signMessage
 */
export async function requestSignMessage(
  telegramUserId: number,
  message: string,
  _address?: string  // Not used - wallet chooses signing address
): Promise<string> {
  const session = getUserSession(telegramUserId);
  if (!session) {
    throw new Error('No active WalletConnect session');
  }

  const client = await getSignClient();

  try {
    const result = await client.request<string | { signature: string } | Record<string, unknown>>({
      topic: session.topic,
      chainId: 'bch:bitcoincash',
      request: {
        method: 'bch_signMessage',
        params: {
          message,
          userPrompt: 'Sign to verify address ownership',
        },
      },
    });

    log('WC', `bch_signMessage raw result: ${JSON.stringify(result, null, 2)}`, telegramUserId);

    // Handle different response formats
    let signature: string;

    if (typeof result === 'string') {
      // Direct string signature
      signature = result;
    } else if (typeof result === 'object' && result !== null) {
      // Object with signature property
      signature = (result as Record<string, unknown>).signature as string
        || (result as Record<string, unknown>).sig as string
        || '';
    } else {
      signature = '';
    }

    log('WC', `Parsed signature: ${signature ? `${signature.slice(0, 20)}...` : 'empty'}`, telegramUserId);
    return signature;
  } catch (error) {
    log('WC', `error requesting signature: ${error}`, telegramUserId);
    throw error;
  }
}

/**
 * Full WalletConnect verification flow
 */
export async function wcVerificationFlow(
  telegramUserId: number,
  challengeMessage: string
): Promise<{
  address: string;
  signature: string;
} | null> {
  try {
    // Get addresses from wallet
    const addressInfos = await requestAddresses(telegramUserId);
    if (addressInfos.length === 0) {
      return null;
    }

    // Use the first address
    const address = addressInfos[0].address;

    // Request signature
    const signature = await requestSignMessage(telegramUserId, challengeMessage, address);

    return { address, signature };
  } catch (error) {
    log('WC', `verification flow error: ${error}`, telegramUserId);
    return null;
  }
}
