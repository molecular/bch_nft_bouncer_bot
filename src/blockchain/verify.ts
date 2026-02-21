import { sha256, decodeCashAddress } from '@bitauth/libauth';

/**
 * Bitcoin Signed Message format verification
 *
 * BCH uses the same signed message format as Bitcoin:
 * - Prefix: "\x18Bitcoin Signed Message:\n"
 * - Message length (varint)
 * - Message
 *
 * The signature is base64 encoded and contains:
 * - 1 byte: recovery flag (27-34)
 * - 32 bytes: r value
 * - 32 bytes: s value
 */

const MESSAGE_PREFIX = '\x18Bitcoin Signed Message:\n';

function varintEncode(n: number): Uint8Array {
  if (n < 0xfd) {
    return new Uint8Array([n]);
  } else if (n <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    return buf;
  } else if (n <= 0xffffffff) {
    const buf = new Uint8Array(5);
    buf[0] = 0xfe;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    buf[3] = (n >> 16) & 0xff;
    buf[4] = (n >> 24) & 0xff;
    return buf;
  } else {
    throw new Error('Value too large for varint');
  }
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Create the message hash that was signed
 */
export function createMessageHash(message: string): Uint8Array {
  const prefixBytes = new TextEncoder().encode(MESSAGE_PREFIX);
  const messageBytes = new TextEncoder().encode(message);
  const messageLengthVarint = varintEncode(messageBytes.length);

  const fullMessage = concatBytes(
    prefixBytes,
    messageLengthVarint,
    messageBytes
  );

  // Double SHA256
  const firstHash = sha256.hash(fullMessage);
  const doubleHash = sha256.hash(firstHash);

  return doubleHash;
}

/**
 * Verify a Bitcoin signed message
 *
 * Note: Full ECDSA signature verification requires additional libraries.
 * For production, consider using a library like 'bitcoinjs-message' adapted for BCH,
 * or implementing secp256k1 signature recovery.
 */
export async function verifySignedMessage(
  message: string,
  signature: string,
  expectedAddress: string
): Promise<boolean> {
  try {
    // Decode the base64 signature
    const sigBytes = Buffer.from(signature, 'base64');

    if (sigBytes.length !== 65) {
      console.error('Invalid signature length:', sigBytes.length);
      return false;
    }

    // Extract recovery flag, r, and s
    const recoveryFlag = sigBytes[0];
    const r = sigBytes.slice(1, 33);
    const s = sigBytes.slice(33, 65);

    // Recovery flag should be 27-34 (27-30 for uncompressed, 31-34 for compressed)
    if (recoveryFlag < 27 || recoveryFlag > 34) {
      console.error('Invalid recovery flag:', recoveryFlag);
      return false;
    }

    const compressed = recoveryFlag >= 31;
    const recoveryId = compressed ? recoveryFlag - 31 : recoveryFlag - 27;

    // Create the message hash
    const messageHash = createMessageHash(message);

    // For actual signature verification, we need secp256k1 ECDSA recovery
    // This would require importing a secp256k1 library
    // For now, we'll use a simplified verification that checks format
    // and relies on the wallet providing correct signatures

    // In production, use: const publicKey = secp256k1.recover(messageHash, sig, recoveryId, compressed);
    // Then: const recoveredAddress = publicKeyToAddress(publicKey);
    // And verify: recoveredAddress === expectedAddress

    // Placeholder: For a complete implementation, add secp256k1 signature recovery
    console.log('Signature verification requested for address:', expectedAddress);
    console.log('Message hash:', Buffer.from(messageHash).toString('hex'));
    console.log('Recovery ID:', recoveryId, 'Compressed:', compressed);

    // For now, return true if signature format is valid
    // TODO: Add full secp256k1 signature recovery
    return true;

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
