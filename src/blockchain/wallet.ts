import { getNetworkProvider, type NetworkProvider } from 'mainnet-js';
import { config } from '../config.js';
import { log } from '../utils/log.js';

let provider: NetworkProvider | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatSuccess: Date | null = null;
let consecutiveFailures = 0;
let isReconnecting = false;

// Callback for when connection is restored after failure
let onReconnect: (() => void) | null = null;

const HEARTBEAT_INTERVAL_MS = 60_000; // Check every minute
const HEARTBEAT_TIMEOUT_MS = 10_000;  // 10 second timeout for health check
const RECONNECT_DELAY_MS = 5_000;     // Wait before reconnect attempt

export function setOnReconnect(callback: () => void): void {
  onReconnect = callback;
}

export async function getProvider(): Promise<NetworkProvider> {
  if (!provider) {
    const servers = config.electrumServer ? config.electrumServer : undefined;
    provider = getNetworkProvider('mainnet', servers);

    if (config.electrumServer) {
      log('electrum', `Using server: ${config.electrumServer}`);
    }
  }
  return provider;
}

/**
 * Start periodic health checks for the Electrum connection
 */
export function startHeartbeat(): void {
  if (heartbeatInterval) return;

  log('electrum', 'Starting connection heartbeat');
  heartbeatInterval = setInterval(checkConnectionHealth, HEARTBEAT_INTERVAL_MS);

  // Run initial check
  checkConnectionHealth();
}

/**
 * Stop the heartbeat
 */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Check connection health by calling ready() with a timeout
 */
async function checkConnectionHealth(): Promise<void> {
  // Skip health check while reconnection is in progress
  if (!provider || isReconnecting) return;

  try {
    // Use ready() with timeout to check if connection is alive
    await provider.ready(HEARTBEAT_TIMEOUT_MS);

    const wasDown = consecutiveFailures > 0;
    consecutiveFailures = 0;
    lastHeartbeatSuccess = new Date();

    if (wasDown) {
      log('electrum', 'Connection restored');
      onReconnect?.();
    }
  } catch (error) {
    consecutiveFailures++;
    log('electrum', `Heartbeat failed (${consecutiveFailures} consecutive): ${error}`);

    // After 3 consecutive failures, try to reconnect
    if (consecutiveFailures >= 3 && !isReconnecting) {
      attemptReconnect(); // Don't await - let it run in background
    }
  }
}

/**
 * Attempt to reconnect by creating a new provider
 */
async function attemptReconnect(): Promise<void> {
  // Prevent concurrent reconnection attempts
  if (isReconnecting) return;
  isReconnecting = true;

  log('electrum', 'Attempting reconnection...');

  try {
    // Disconnect old provider and clear reference
    if (provider) {
      try {
        await provider.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      provider = null;
    }

    // Wait a bit for socket cleanup before creating new connection
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));

    // Create new provider
    const servers = config.electrumServer ? config.electrumServer : undefined;
    provider = getNetworkProvider('mainnet', servers);

    // Wait for it to be ready
    await provider.ready(HEARTBEAT_TIMEOUT_MS);

    log('electrum', 'Reconnection successful');
    consecutiveFailures = 0;
    lastHeartbeatSuccess = new Date();

    // Notify that reconnection happened so subscriptions can be restored
    onReconnect?.();
  } catch (error) {
    log('electrum', `Reconnection failed: ${error}`);
    // Keep trying on next heartbeat cycle
  } finally {
    isReconnecting = false;
  }
}

/**
 * Get connection status info
 */
export function getConnectionStatus(): {
  connected: boolean;
  lastSuccess: Date | null;
  consecutiveFailures: number;
  reconnecting: boolean;
} {
  return {
    connected: consecutiveFailures === 0 && lastHeartbeatSuccess !== null,
    lastSuccess: lastHeartbeatSuccess,
    consecutiveFailures,
    reconnecting: isReconnecting,
  };
}

export async function disconnectProvider(): Promise<void> {
  stopHeartbeat();
  isReconnecting = false;
  if (provider) {
    try {
      await provider.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    provider = null;
  }
}
