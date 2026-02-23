import { Api } from 'grammy';

/**
 * Restrict a user in a group - remove posting permissions
 */
export async function restrictUser(api: Api, chatId: number, userId: number): Promise<void> {
  await api.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_invite_users: false,
    },
  });
}

/**
 * Unrestrict a user in a group - restore to regular member with group default permissions.
 *
 * Uses promote/demote cycle because restrictChatMember with all permissions=true
 * keeps the user in "restricted" status (in the exceptions list). The promote/demote
 * cycle changes their status category entirely, making them a regular "member".
 *
 * Requires the bot to have "Add new admins" (can_promote_members) permission.
 */
export async function unrestrictUser(api: Api, chatId: number, userId: number): Promise<void> {
  // Promote to admin with no rights, then demote back to member.
  // This removes them from the restricted exceptions list entirely.
  await api.promoteChatMember(chatId, userId, {
    can_manage_chat: false,
    can_change_info: false,
    can_delete_messages: false,
    can_invite_users: false,
    can_restrict_members: false,
    can_pin_messages: false,
    can_promote_members: false,
    can_manage_video_chats: false,
  });

  // Small delay to ensure Telegram processes the promotion
  await new Promise(resolve => setTimeout(resolve, 300));

  // Demote back to regular member (calling promote with no rights on an admin demotes them)
  await api.promoteChatMember(chatId, userId, {
    can_manage_chat: false,
    can_change_info: false,
    can_delete_messages: false,
    can_invite_users: false,
    can_restrict_members: false,
    can_pin_messages: false,
    can_promote_members: false,
    can_manage_video_chats: false,
  });
  // User is now a regular member with the group's default permissions
}

/**
 * Check if a user is currently restricted in a group
 */
export async function isUserRestricted(api: Api, chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await api.getChatMember(chatId, userId);
    return member.status === 'restricted';
  } catch {
    return false;
  }
}

/**
 * Unrestrict a user only if they're currently restricted
 */
export async function unrestrictIfNeeded(api: Api, chatId: number, userId: number): Promise<boolean> {
  if (await isUserRestricted(api, chatId, userId)) {
    await unrestrictUser(api, chatId, userId);
    return true;
  }
  return false;
}
