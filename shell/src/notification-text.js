// How a notification reads and where it leads. Framework-free: the
// Notifications dialog, the in-tab alert and the push service worker
// (push-sw.js) all render the same row the same way.

export function actorName(item) {
  return item.actor?.name || item.actor?.login || 'Someone';
}

// What happened, without the actor (the row sets the actor in bold).
export function notificationAction(item) {
  const count = Number(item.count) || 1;
  if (item.kind === 'reaction') return `reacted ${item.emoji || ''}${count > 1 ? ` and ${count - 1} more` : ''}`;
  if (item.kind === 'mention') return 'mentioned you';
  if (item.kind === 'reply') return `replied${count > 1 ? ` and ${count - 1} more replied` : ''}`;
  if (item.kind === 'access_request') return 'asked for access to';
  if (item.kind === 'team_join_request') return 'asked to join';
  if (item.kind === 'access_granted') return 'gave you access to';
  return `commented${count > 1 ? ` and ${count - 1} more commented` : ''}`;
}

// One line, for a desktop alert's title.
export function joiner(item) {
  return item.kind === 'access_request' || item.kind === 'access_granted' || item.kind === 'team_join_request' ? '' : ' on';
}

export function notificationLabel(item) {
  return `${actorName(item)} ${notificationAction(item)}${joiner(item)} ${item.title || item.slug}`;
}

export function notificationTarget(item) {
  if (!item?.slug) return '';
  if (item.kind === 'team_join_request' && item.team_id) return `/me?team=${encodeURIComponent(item.team_id)}&view=settings`;
  // Access is about the document, not a comment: open its latest version.
  if (item.kind === 'access_request' || item.kind === 'access_granted') return `/d/${encodeURIComponent(item.slug)}`;
  const version = Math.max(1, Number(item.version) || 1);
  const target = item.comment_id || item.thread_id;
  const query = target ? `?comment=${encodeURIComponent(target)}` : '';
  return `/d/${encodeURIComponent(item.slug)}/v/${version}${query}`;
}
