import { getNetworkProvider, type NetworkProvider } from 'mainnet-js';
import { config } from '../config.js';

let provider: NetworkProvider | null = null;

export async function getProvider(): Promise<NetworkProvider> {
  if (!provider) {
    const servers = config.electrumServer ? config.electrumServer : undefined;
    provider = getNetworkProvider('mainnet', servers);

    if (config.electrumServer) {
      console.log(`Using electrum server: ${config.electrumServer}`);
    }
  }
  return provider;
}

export async function disconnectProvider(): Promise<void> {
  if (provider) {
    // ElectrumNetworkProvider handles cleanup internally
    provider = null;
  }
}
