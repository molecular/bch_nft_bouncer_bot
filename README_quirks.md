# Telegram API Quirks & Workarounds

This document describes undocumented Telegram Bot API behaviors discovered during development and the workarounds used.

---

## Unrestricting Users: The Promote/Demote Workaround

### The Problem

When a user is restricted in a Telegram group (added to the "exceptions" list with limited permissions), the documented way to lift restrictions is:

> "Pass `True` for all permissions to lift restrictions from a user."
> — [Telegram Bot API docs](https://core.telegram.org/bots/api#restrictchatmember)

However, this doesn't actually work as expected. When you call `restrictChatMember` with all permissions set to `true`:

1. The API returns `true` (success)
2. But the user remains in the "restricted" status category
3. Their actual permissions stay `false` (unchanged)
4. Telegram's UI still shows them as "restricted by bot" in the group's exceptions list

We verified this with extensive logging:

```
[unrestrictUser] Sending permissions: {"can_send_messages":true, ...all true...}
[unrestrictUser] API returned: true
[unrestrictUser] After unrestrict, user status: restricted
[unrestrictUser] User's actual permissions: {"can_send_messages":false, ...all false...}
```

The API claims success but does nothing.

### The Workaround

The solution is to use `promoteChatMember` to temporarily make the user an admin (with zero admin rights), then immediately "demote" them by calling `promoteChatMember` again. This changes their status category entirely:

```
restricted → administrator → member
```

```typescript
// Promote to admin with no actual powers
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

// Small delay for Telegram to process
await new Promise(resolve => setTimeout(resolve, 300));

// "Demote" by calling promote again with no rights (on an admin, this demotes them)
await api.promoteChatMember(chatId, userId, {
  can_manage_chat: false,
  // ... same as above
});

// User is now a regular "member" with group's default permissions
```

### Why This Works

- `restrictChatMember` modifies permissions *within* the "restricted" status category
- `promoteChatMember` changes the user's status category entirely
- When you promote a restricted user to admin (even with no rights), they leave the restricted category
- When you demote an admin with no rights, they become a regular "member" (not restricted)
- As a regular member, they automatically inherit the group's default permissions

### Bot Permission Requirements

This workaround requires the bot to have the **"Add new admins"** (`can_promote_members`) permission in the group. This is in addition to the standard "Restrict members" permission.

### Status

As of February 2026, this behavior is undocumented. We did not find any references to others encountering this specific issue (API returning success but not actually lifting restrictions).

---

## Other Quirks

*(Add other discovered quirks here as they're found)*
