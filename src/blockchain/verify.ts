import { decodeCashAddress } from '@bitauth/libauth';
import { SignedMessage } from 'mainnet-js';

/**
 * Convert hex string to base64
 */
function hexToBase64(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  return bytes.toString('base64');
}

/**
 * Check if string is hex
 */
function isHex(str: string): boolean {
  return /^[0-9a-fA-F]+$/.test(str);
}

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

    // Normalize signature - convert hex to base64 if needed
    let normalizedSig = signature;
    if (isHex(signature) && signature.length >= 128) {
      // Looks like hex signature, convert to base64
      normalizedSig = hexToBase64(signature);
      console.log('Converted hex signature to base64:', normalizedSig.slice(0, 20) + '...');
    }

    // Use mainnet-js SignedMessage.verify
    const result = SignedMessage.verify(message, normalizedSig, address);

    console.log('Signature verification result:', {
      address,
      valid: result.valid,
      details: result.details,
    });

    return result.valid;
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
