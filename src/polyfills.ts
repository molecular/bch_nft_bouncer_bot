// Polyfills for Node.js compatibility with WalletConnect
// Must be imported before any WalletConnect code

import { Crypto } from '@peculiar/webcrypto';

if (!globalThis.crypto) {
  globalThis.crypto = new Crypto();
}

// Also ensure getRandomValues is available
if (!globalThis.crypto.getRandomValues) {
  const crypto = new Crypto();
  globalThis.crypto.getRandomValues = crypto.getRandomValues.bind(crypto);
}
