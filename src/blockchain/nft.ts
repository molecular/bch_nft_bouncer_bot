import { ElectrumNetworkProvider } from 'mainnet-js';
import { getProvider } from './wallet.js';

export interface TokenUtxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  token?: {
    category: string;
    amount: bigint;
    nft?: {
      capability: 'none' | 'mutable' | 'minting';
      commitment: string;
    };
  };
}

export interface OwnedNft {
  category: string;
  commitment: string | null;
  txid: string;
  vout: number;
}

/**
 * Get all token UTXOs for an address
 */
export async function getTokenUtxos(address: string): Promise<TokenUtxo[]> {
  const provider = await getProvider();

  try {
    const utxos = await provider.getUtxos(address);

    // Filter to only token UTXOs
    return utxos
      .filter((utxo: any) => utxo.token)
      .map((utxo: any) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        satoshis: BigInt(utxo.satoshis),
        token: utxo.token ? {
          category: utxo.token.category,
          amount: BigInt(utxo.token.amount || 0),
          nft: utxo.token.nft ? {
            capability: utxo.token.nft.capability,
            commitment: utxo.token.nft.commitment || '',
          } : undefined,
        } : undefined,
      }));
  } catch (error) {
    console.error(`Error fetching token UTXOs for ${address}:`, error);
    throw error;
  }
}

/**
 * Check if an address owns any NFT from the specified categories
 */
export async function checkNftOwnership(
  address: string,
  categories: string[]
): Promise<OwnedNft[]> {
  const tokenUtxos = await getTokenUtxos(address);

  console.log(`[nft] checkNftOwnership: address=${address.slice(0, 30)}..., got ${tokenUtxos.length} token UTXOs, checking against ${categories.length} categories`);

  const ownedNfts: OwnedNft[] = [];

  for (const utxo of tokenUtxos) {
    if (!utxo.token) continue;

    // Check if this token's category is in our list
    const categoryLower = utxo.token.category.toLowerCase();
    const matchingCategory = categories.find(
      c => c.toLowerCase() === categoryLower
    );

    if (matchingCategory && utxo.token.nft) {
      ownedNfts.push({
        category: utxo.token.category,
        commitment: utxo.token.nft.commitment || null,
        txid: utxo.txid,
        vout: utxo.vout,
      });
    }
  }

  return ownedNfts;
}

/**
 * Check if a specific NFT (by category and commitment) is still at an address
 */
export async function isNftAtAddress(
  address: string,
  category: string,
  commitment: string | null
): Promise<boolean> {
  const tokenUtxos = await getTokenUtxos(address);

  return tokenUtxos.some(utxo => {
    if (!utxo.token?.nft) return false;

    const categoryMatch = utxo.token.category.toLowerCase() === category.toLowerCase();
    const commitmentMatch = commitment === null
      ? !utxo.token.nft.commitment || utxo.token.nft.commitment === ''
      : utxo.token.nft.commitment === commitment;

    return categoryMatch && commitmentMatch;
  });
}

/**
 * Validate a CashToken category ID format
 */
export function isValidCategoryId(category: string): boolean {
  // Category ID is a 32-byte (64 hex chars) transaction ID
  return /^[a-fA-F0-9]{64}$/.test(category);
}
