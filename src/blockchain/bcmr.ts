/**
 * BCMR (Bitcoin Cash Metadata Registry) integration
 *
 * Fetches token metadata from Paytaca's BCMR indexer API.
 * Caches results in SQLite to minimize API calls.
 */

import {
  getTokenMetadata,
  upsertTokenMetadata,
  isTokenMetadataStale,
} from '../storage/queries.js';
import type { TokenMetadata } from '../storage/types.js';

const PAYTACA_BCMR_API = 'https://bcmr.paytaca.com/api/tokens';

interface PaytacaTokenResponse {
  category?: string;
  name?: string;
  symbol?: string;
  description?: string;
  decimals?: number;
  icon?: string;
  image?: string;
  web?: string;
  // NFT types can have more fields, but we only need basics
}

/**
 * Fetch token metadata, using cache if available and fresh.
 * Returns null if metadata not found (graceful degradation).
 */
export async function fetchTokenMetadata(
  category: string,
  forceRefresh: boolean = false
): Promise<TokenMetadata | null> {
  // Check cache first
  if (!forceRefresh && !isTokenMetadataStale(category)) {
    const cached = getTokenMetadata(category);
    if (cached) {
      return cached;
    }
  }

  // Fetch from Paytaca API
  try {
    const response = await fetch(`${PAYTACA_BCMR_API}/${category}/`);

    if (!response.ok) {
      if (response.status === 404) {
        // Token not in registry - cache as "no metadata" to avoid repeated lookups
        upsertTokenMetadata(category, null, null, null, null, null, null);
        return null;
      }
      console.error(`BCMR API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as PaytacaTokenResponse;

    // Store in cache
    upsertTokenMetadata(
      category,
      data.name || null,
      data.symbol || null,
      data.description || null,
      data.icon || null,
      data.image || null,
      data.decimals ?? null
    );

    return getTokenMetadata(category) || null;
  } catch (error) {
    console.error(`BCMR fetch error for ${category}:`, error);
    return null;
  }
}

/**
 * Format a token for display, with graceful fallback if no metadata.
 *
 * Examples:
 *   With metadata: "CashCats (CATS)"
 *   Without metadata: "0123456789ab...cdef"
 */
export function formatTokenName(
  category: string,
  metadata: TokenMetadata | null
): string {
  if (metadata?.name) {
    if (metadata.symbol) {
      return `${metadata.name} (${metadata.symbol})`;
    }
    return metadata.name;
  }
  // Fallback: truncated category ID
  return `${category.slice(0, 12)}...${category.slice(-4)}`;
}

/**
 * Format token for display with commitment (for NFTs).
 *
 * Examples:
 *   With metadata: "CashCats #42"
 *   Without metadata: "0123456789ab...cdef (abc123...)"
 */
export function formatNftDisplay(
  category: string,
  commitment: string | null,
  metadata: TokenMetadata | null
): string {
  const tokenName = formatTokenName(category, metadata);

  if (commitment) {
    // Try to display commitment as readable if it's short enough
    if (commitment.length <= 16) {
      return `${tokenName} #${commitment}`;
    }
    return `${tokenName} (${commitment.slice(0, 8)}...)`;
  }

  return tokenName;
}

/**
 * Fetch and format token in one call (convenience function).
 */
export async function getFormattedTokenName(category: string): Promise<string> {
  const metadata = await fetchTokenMetadata(category);
  return formatTokenName(category, metadata);
}

/**
 * Fetch and format NFT in one call (convenience function).
 */
export async function getFormattedNftDisplay(
  category: string,
  commitment: string | null
): Promise<string> {
  const metadata = await fetchTokenMetadata(category);
  return formatNftDisplay(category, commitment, metadata);
}
