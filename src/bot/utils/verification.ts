/**
 * Shared verification utilities.
 */

import { Api } from 'grammy';

/**
 * Escape special characters for Telegram Markdown (legacy mode).
 * Characters that need escaping: \ _ * ` [
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}

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
