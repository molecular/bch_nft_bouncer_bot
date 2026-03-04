/**
 * Telegram Markdown formatting utilities
 */

/**
 * Escape special characters for Telegram Markdown (legacy mode).
 * Characters that need escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * For our use case, underscores are the main issue in usernames/URLs.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/_/g, '\\_');
}

/**
 * Escape a URL for use in Telegram Markdown.
 * Underscores in URLs break Markdown parsing.
 */
export function escapeMarkdownUrl(url: string): string {
  return url.replace(/_/g, '\\_');
}
