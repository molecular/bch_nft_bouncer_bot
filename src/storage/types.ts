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
  nft_category: string;
  nft_commitment: string | null;
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
