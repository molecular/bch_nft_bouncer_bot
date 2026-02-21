import { decodeCashAddress } from '@bitauth/libauth';
import { SignedMessage } from 'mainnet-js';

/**
 * Verify a Bitcoin signed message using mainnet-js
 */
export async function verifySignedMessage(
  message: string,
  signature: string,
  expectedAddress: string
): Promise<boolean> {
  try {
    // Normalize address
    const address = expectedAddress.startsWith('bitcoincash:')
      ? expectedAddress
      : `bitcoincash:${expectedAddress}`;

    // Use mainnet-js SignedMessage.verify
    const result = SignedMessage.verify(message, signature, address);

    console.log('Signature verification result:', {
      address,
      signatureValid: result.signatureValid,
      signatureType: result.signatureType,
    });

    return result.signatureValid;
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Generate a challenge message for signing
 */
export function generateChallengeMessage(
  groupName: string,
  groupId: number,
  nonce: string
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  return `Verify NFT ownership for "${groupName}" (${groupId})\nnonce=${nonce}\ntime=${timestamp}`;
}

/**
 * Parse a challenge message to extract components
 */
export function parseChallengeMessage(message: string): {
  groupId: number;
  nonce: string;
  timestamp: number;
} | null {
  try {
    const lines = message.split('\n');
    if (lines.length < 3) return null;

    const groupMatch = lines[0].match(/\((-?\d+)\)$/);
    const nonceMatch = lines[1].match(/^nonce=([a-f0-9]+)$/i);
    const timeMatch = lines[2].match(/^time=(\d+)$/);

    if (!groupMatch || !nonceMatch || !timeMatch) return null;

    return {
      groupId: parseInt(groupMatch[1], 10),
      nonce: nonceMatch[1],
      timestamp: parseInt(timeMatch[1], 10),
    };
  } catch {
    return null;
  }
}

/**
 * Validate a BCH address format
 */
export function isValidBchAddress(address: string): boolean {
  try {
    // Normalize address - add prefix if missing
    const fullAddress = address.startsWith('bitcoincash:')
      ? address
      : `bitcoincash:${address}`;

    // Try to decode as CashAddress using libauth
    const decoded = decodeCashAddress(fullAddress);
    return typeof decoded !== 'string'; // Returns error string on failure, object on success
  } catch {
    return false;
  }
}
