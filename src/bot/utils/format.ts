/**
 * Telegram Markdown formatting utilities
 */

/**
 * Escape special characters for Telegram Markdown (legacy mode).
 * Characters that need escaping in legacy mode: _ * ` [
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}
