/**
 * Shared verification utilities.
 */

import { Api, InputFile } from 'grammy';
import { fetchTokenMetadata, formatNftDisplay, resolveImageUri } from '../../blockchain/bcmr.js';
import { fetchAndResizeImage } from '../../blockchain/images.js';

export interface MatchingNftInfo {
  category: string;
  commitment?: string;
}

/**
 * Send a "verified" message to a group, with NFT image if available.
 * Falls back to text-only if no image or fetch fails.
 */
export async function sendVerifiedMessage(
  api: Api,
  groupId: number,
  username: string,
  matchingNft?: MatchingNftInfo
): Promise<void> {
  let verifiedMsg = `✅ ${username} verified!`;
  let metadata = null;

  if (matchingNft) {
    metadata = await fetchTokenMetadata(matchingNft.category);
    const nftDisplay = formatNftDisplay(
      matchingNft.category,
      matchingNft.commitment || null,
      metadata
    );
    verifiedMsg += ` Found: ${nftDisplay}`;
  }

  // Try to send with image if available
  let sentWithImage = false;
  if (metadata) {
    const imageUrl = resolveImageUri(metadata.icon_uri || metadata.image_uri);
    if (imageUrl) {
      try {
        const imageBuffer = await fetchAndResizeImage(imageUrl);
        if (imageBuffer) {
          await api.sendPhoto(groupId, new InputFile(imageBuffer, 'nft.png'), {
            caption: verifiedMsg,
          });
          sentWithImage = true;
        }
      } catch (err) {
        console.error('Failed to send verification image:', err);
      }
    }
  }

  // Fallback to text-only
  if (!sentWithImage) {
    await api.sendMessage(groupId, verifiedMsg);
  }
}
