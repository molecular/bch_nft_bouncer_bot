export interface Group {
  id: number; // Telegram chat ID
  name: string | null;
  created_at: string;
}

export interface GroupNftCategory {
  group_id: number;
  category: string; // CashToken category ID (hex)
}

export interface Verification {
  id: number;
  telegram_user_id: number;
  telegram_username: string | null;
  group_id: number;
  bch_address: string;
  verified_at: string;
}

export interface Challenge {
  id: number;
  telegram_user_id: number;
  group_id: number | null;
  nonce: string;
  bch_address: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface PendingKick {
  id: number;
  telegram_user_id: number;
  group_id: number;
  kicked_at: string;
  prompt_message_id: number | null;
  warned_at: string | null;
}

export interface TokenMetadata {
  category: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  icon_uri: string | null;
  image_uri: string | null;
  decimals: number | null;
  fetched_at: string;
}

// Access rule types for gating group access
export type AccessRuleType = 'nft' | 'balance';

export interface AccessRule {
  id: number;
  group_id: number;
  rule_type: AccessRuleType;
  category: string | null;        // Token category ID, or 'BCH' for BCH balance
  start_commitment: string | null; // Hex, inclusive (nft with range only)
  end_commitment: string | null;   // Hex, inclusive (nft with range only)
  min_amount: string | null;       // BigInt as string (balance rules only)
  label: string | null;            // Human-readable (e.g., "Jessicas", "21 BCH Club")
  created_at: string;
}
