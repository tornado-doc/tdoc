// What the composer asks before a mention adds someone to a doc
// (panel/invite-confirm.jsx).
// An actor key: a GitHub login, or `email:<address>`.
export function inviteName(key) {
  const k = String(key);
  return k.startsWith('email:') ? k.slice(6) : `@${k}`;
}
export function inviteQuestion(keys) {
  const names = keys.map(inviteName);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return `Add ${list} to this doc? They can read it.`;
}
