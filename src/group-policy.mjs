// Group access is opt-in and uses structured mention IDs, never display names.
export function isAllowedGroup(config, chatId) {
  return Boolean(chatId && Array.isArray(config.allowedGroupChatIds) && config.allowedGroupChatIds.includes(chatId));
}

export function isMentionedGroupMessage(config, event) {
  return event.chat_type === "group" && event.sender_type === "user" &&
    isAllowedGroup(config, event.chat_id) && Boolean(config.botOpenId) &&
    Array.isArray(event.mentions) && event.mentions.some((mention) => mention.id === config.botOpenId);
}

export function stripGroupMentionPrefix(event) {
  let content = String(event.content ?? "").trim();
  if (event.chat_type !== "group" || !Array.isArray(event.mentions)) return content;
  // The CLI renders mentions as names, but older payloads can contain placeholder keys.
  // Remove routing prefixes only; mentions inside the request remain part of its meaning.
  const prefixes = event.mentions.flatMap((mention) => [mention.key, mention.name ? `@${mention.name}` : null])
    .filter((value) => typeof value === "string" && value.length > 1).sort((a, b) => b.length - a.length);
  while (content) {
    const prefix = prefixes.find((value) => content.startsWith(value) &&
      (content.length === value.length || /^[\s@,，:：]/u.test(content.slice(value.length))));
    if (!prefix) break;
    content = content.slice(prefix.length).replace(/^[\s,，:：]+/u, "");
  }
  return content.trim();
}

export function validateGroupConfig(config) {
  const groups = config.allowedGroupChatIds ?? [];
  if (!Array.isArray(groups) || groups.some((id) => typeof id !== "string" || !/^oc_[a-z0-9]+$/i.test(id))) {
    throw new Error("allowedGroupChatIds must be an array of explicit Feishu chat IDs");
  }
  if (groups.length && !/^ou_[a-z0-9]+$/i.test(config.botOpenId ?? "")) {
    throw new Error("botOpenId is required when group chats are enabled");
  }
}
