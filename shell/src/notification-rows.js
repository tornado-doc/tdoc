// Bell rows across pages. Framework-free: the bell (use-notifications) and
// My docs' Needs you page through /api/notifications the same way.

// `rows` after `list`, without any row whose id is already there. A row that
// arrives between two page loads shifts the server's pages by one, so the
// next page repeats the last row of the one before: it is kept once.
export function appendUnique(list, rows) {
  const ids = new Set((list || []).map((row) => row && row.id));
  const out = [...(list || [])];
  for (const row of rows || []) {
    if (!row || ids.has(row.id)) continue;
    ids.add(row.id);
    out.push(row);
  }
  return out;
}
