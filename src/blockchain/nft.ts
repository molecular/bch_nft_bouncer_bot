import { ElectrumNetworkProvider } from 'mainnet-js';
import { getProvider } from './wallet.js';
import type { AccessRule } from '../storage/types.js';

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

// ============ Commitment Range Comparison ============

/**
 * Compare two hex commitment strings numerically
 * Returns -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareCommitments(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/^0x/, '');
  const aNorm = normalize(a);
  const bNorm = normalize(b);
  const maxLen = Math.max(aNorm.length, bNorm.length);
  const aNum = BigInt('0x' + aNorm.padStart(maxLen, '0'));
  const bNum = BigInt('0x' + bNorm.padStart(maxLen, '0'));
  return aNum < bNum ? -1 : aNum > bNum ? 1 : 0;
}

/**
 * Check if a commitment falls within a range (inclusive)
 */
export function isCommitmentInRange(
  commitment: string | null,
  start: string | null,
  end: string | null
): boolean {
  // No range specified = all commitments match
  if (!start && !end) return true;
  // Range specified but no commitment = no match
  if (!commitment) return false;
  // Check bounds
  if (start && compareCommitments(commitment, start) < 0) return false;
  if (end && compareCommitments(commitment, end) > 0) return false;
  return true;
}

// ============ Balance and NFT Info ============

export interface AddressBalanceInfo {
  bchSatoshis: bigint;
  fungibleTokens: Map<string, bigint>;  // category -> amount
  nfts: OwnedNft[];
}

/**
 * Get complete balance info for an address: BCH satoshis, fungible tokens, and NFTs
 */
export async function getAddressBalanceInfo(address: string): Promise<AddressBalanceInfo> {
  const provider = await getProvider();

  try {
    const utxos = await provider.getUtxos(address);

    let bchSatoshis = 0n;
    const fungibleTokens = new Map<string, bigint>();
    const nfts: OwnedNft[] = [];

    for (const utxo of utxos as any[]) {
      // Add BCH value
      bchSatoshis += BigInt(utxo.satoshis);

      if (utxo.token) {
        const category = utxo.token.category.toLowerCase();

        if (utxo.token.nft) {
          // NFT
          nfts.push({
            category: utxo.token.category,
            commitment: utxo.token.nft.commitment || null,
            txid: utxo.txid,
            vout: utxo.vout,
          });
        } else if (utxo.token.amount) {
          // Fungible token
          const amount = BigInt(utxo.token.amount);
          const current = fungibleTokens.get(category) || 0n;
          fungibleTokens.set(category, current + amount);
        }
      }
    }

    return { bchSatoshis, fungibleTokens, nfts };
  } catch (error) {
    console.error(`Error fetching balance info for ${address}:`, error);
    throw error;
  }
}

// ============ Access Rule Checking ============

export interface NftRuleResult {
  satisfied: boolean;
  rule: AccessRule;
  matchingNft?: OwnedNft;
}

export interface BalanceRuleResult {
  satisfied: boolean;
  rule: AccessRule;
  actualAmount?: bigint;
}

export interface AccessRulesCheckResult {
  satisfied: boolean;        // Overall: AND logic between rule types
  nftSatisfied: boolean;     // At least one NFT rule satisfied (OR logic)
  balanceSatisfied: boolean; // At least one balance rule satisfied (OR logic)
  nftResults: NftRuleResult[];
  balanceResults: BalanceRuleResult[];
}

/**
 * Check access rules against an address
 * - NFT rules: OR logic - at least one must be satisfied
 * - Balance rules: OR logic - at least one must be satisfied
 * - Between types: AND logic - if both types exist, must satisfy at least one of each
 */
export async function checkAccessRules(
  address: string,
  rules: AccessRule[]
): Promise<AccessRulesCheckResult> {
  const info = await getAddressBalanceInfo(address);

  const nftRules = rules.filter(r => r.rule_type === 'nft');
  const balanceRules = rules.filter(r => r.rule_type === 'balance');

  // Check NFT rules (OR logic - at least one must pass)
  const nftResults: NftRuleResult[] = nftRules.map(rule => {
    const match = info.nfts.find(nft =>
      nft.category.toLowerCase() === rule.category?.toLowerCase() &&
      isCommitmentInRange(nft.commitment, rule.start_commitment, rule.end_commitment)
    );
    return { satisfied: !!match, rule, matchingNft: match };
  });
  const nftSatisfied = nftRules.length === 0 || nftResults.some(r => r.satisfied);

  // Check balance rules (OR logic - at least one must pass)
  const balanceResults: BalanceRuleResult[] = balanceRules.map(rule => {
    const minAmount = BigInt(rule.min_amount || '0');
    let actualAmount: bigint;

    if (rule.category?.toUpperCase() === 'BCH') {
      actualAmount = info.bchSatoshis;
    } else {
      actualAmount = info.fungibleTokens.get(rule.category?.toLowerCase() || '') || 0n;
    }

    return { satisfied: actualAmount >= minAmount, rule, actualAmount };
  });
  const balanceSatisfied = balanceRules.length === 0 || balanceResults.some(r => r.satisfied);

  // AND between types
  const satisfied = nftSatisfied && balanceSatisfied;

  return { satisfied, nftSatisfied, balanceSatisfied, nftResults, balanceResults };
}

/**
 * Check access rules against multiple addresses (combines results)
 * - NFT rules: OR logic across all addresses (any address having the NFT counts)
 * - Balance rules: AGGREGATE across all addresses (sum balances, then check threshold)
 * - Between types: AND logic
 */
export async function checkAccessRulesMultiAddress(
  addresses: string[],
  rules: AccessRule[]
): Promise<AccessRulesCheckResult> {
  const nftRules = rules.filter(r => r.rule_type === 'nft');
  const balanceRules = rules.filter(r => r.rule_type === 'balance');

  if (addresses.length === 0) {
    return {
      satisfied: false,
      nftSatisfied: nftRules.length === 0,
      balanceSatisfied: balanceRules.length === 0,
      nftResults: [],
      balanceResults: [],
    };
  }

  // Get balance info for all addresses
  const addressInfos = await Promise.all(addresses.map(addr => getAddressBalanceInfo(addr)));

  // Aggregate balances across all addresses
  let totalBch = 0n;
  const totalFungibles = new Map<string, bigint>();
  const allNfts: OwnedNft[] = [];

  for (const info of addressInfos) {
    totalBch += info.bchSatoshis;
    for (const [category, amount] of info.fungibleTokens) {
      totalFungibles.set(category, (totalFungibles.get(category) || 0n) + amount);
    }
    allNfts.push(...info.nfts);
  }

  // Check NFT rules (OR logic - any address having the NFT counts)
  const nftResults: NftRuleResult[] = nftRules.map(rule => {
    const match = allNfts.find(nft =>
      nft.category.toLowerCase() === rule.category?.toLowerCase() &&
      isCommitmentInRange(nft.commitment, rule.start_commitment, rule.end_commitment)
    );
    return { satisfied: !!match, rule, matchingNft: match };
  });

  // Check balance rules against AGGREGATED balances
  const balanceResults: BalanceRuleResult[] = balanceRules.map(rule => {
    const minAmount = BigInt(rule.min_amount || '0');
    let actualAmount: bigint;

    if (rule.category?.toUpperCase() === 'BCH') {
      actualAmount = totalBch;
    } else {
      actualAmount = totalFungibles.get(rule.category?.toLowerCase() || '') || 0n;
    }

    return { satisfied: actualAmount >= minAmount, rule, actualAmount };
  });

  const nftSatisfied = nftRules.length === 0 || nftResults.some(r => r.satisfied);
  const balanceSatisfied = balanceRules.length === 0 || balanceResults.some(r => r.satisfied);
  const satisfied = nftSatisfied && balanceSatisfied;

  return { satisfied, nftSatisfied, balanceSatisfied, nftResults, balanceResults };
}
