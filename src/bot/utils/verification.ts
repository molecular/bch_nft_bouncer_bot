/**
 * Shared verification utilities.
 */

import { Api } from 'grammy';

/**
 * Send a simple "verified" message to a group.
 */
export async function sendVerifiedMessage(
  api: Api,
  groupId: number,
  username: string
): Promise<void> {
  await api.sendMessage(groupId, `✅ ${username} verified!`);
}
