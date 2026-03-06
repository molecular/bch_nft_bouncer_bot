/**
 * Image fetching and resizing for NFT verification announcements.
 *
 * Handles fetching images from URLs (including IPFS gateways) and
 * resizing them to be suitable for Telegram (max 10MB, target ~1MB).
 */

import * as sharpModule from 'sharp';

// Handle esm/cjs interop - sharp exports default
const sharp = (sharpModule as any).default || sharpModule;

const MAX_IMAGE_SIZE = 512 * 1024; // 512KB target
const MAX_DIMENSION = 512; // Max width (icons don't need to be large)
const FETCH_TIMEOUT = 10000; // 10 seconds

/**
 * Fetch an image from a URL and resize if needed.
 * Returns null if fetch fails or image is invalid.
 */
export async function fetchAndResizeImage(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        // Some servers require a User-Agent
        'User-Agent': 'NFT-Entry-Bot/1.0',
      },
    });

    if (!response.ok) {
      console.error(`Image fetch failed: ${response.status} ${response.statusText} for ${url}`);
      return null;
    }

    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.startsWith('image/')) {
      console.error(`Not an image: ${contentType} for ${url}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Always resize to MAX_DIMENSION for consistent small images
    const resized = await sharp(buffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png() // Keep as PNG for icons (better for graphics with transparency)
      .toBuffer();

    return resized;
  } catch (err) {
    console.error('Image fetch/resize failed:', err);
    return null;
  }
}
