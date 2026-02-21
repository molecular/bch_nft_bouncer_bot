import { getSignClient, getUserSession, setUserAddresses } from './session.js';

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
    const result = await client.request<BchAddressInfo[]>({
      topic: session.topic,
      chainId: 'bch:bitcoincash',
      request: {
        method: 'bch_getAddresses',
        params: {},
      },
    });

    // Store addresses for later use
    const addresses = result.map(a => a.address);
    setUserAddresses(telegramUserId, addresses);

    return result;
  } catch (error) {
    console.error('Error requesting addresses:', error);
    throw error;
  }
}

/**
 * Request a message signature from connected wallet using bch_signMessage
 */
export async function requestSignMessage(
  telegramUserId: number,
  message: string,
  address: string
): Promise<string> {
  const session = getUserSession(telegramUserId);
  if (!session) {
    throw new Error('No active WalletConnect session');
  }

  const client = await getSignClient();

  try {
    const result = await client.request<{ signature: string }>({
      topic: session.topic,
      chainId: 'bch:bitcoincash',
      request: {
        method: 'bch_signMessage',
        params: {
          message,
          address,
        },
      },
    });

    return result.signature;
  } catch (error) {
    console.error('Error requesting signature:', error);
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
    console.error('WC verification flow error:', error);
    return null;
  }
}
